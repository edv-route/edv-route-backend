/* eslint-disable camelcase */

/**
 * Which invoices a payment covers stops being a JSON array and becomes a real
 * relation (2026-08-18).
 *
 * Until now a partial payment stored its targeted invoices in
 * `payment_submissions.context->'invoiceIds'`. That is a foreign key hiding
 * inside a blob: nothing stopped it pointing at an invoice that no longer
 * exists, and — more importantly — no database constraint could express the one
 * invariant that matters since multiple pending payments were allowed
 * (2026-08-12): **an invoice may be reserved by at most ONE pending payment**.
 * That invariant lived only in application code (an advisory lock plus a
 * re-check), so any new insert path would silently bypass it and charge the same
 * invoice twice. Money must not depend on every future caller remembering.
 *
 * `submission_status` is a copy of the parent's status kept by trigger: a partial
 * unique index cannot look at another table, and doing it by trigger keeps the
 * guarantee at the database level instead of handing it back to the code.
 *
 * Scope: this covers the payments that ENUMERATE their invoices. A generator
 * submission (enroll/advance/change_plan) reserves through the charges it
 * creates, which already carry a real `submission_id` foreign key.
 *
 * EXPAND/CONTRACT: dev and prod share one database and prod still runs the
 * previous build, so this migration only ADDS. See the note further down.
 */

exports.up = (pgm) => {
  pgm.createTable('payment_submission_invoices', {
    submission_id: {
      type: 'uuid',
      notNull: true,
      references: 'payment_submissions',
      onDelete: 'CASCADE',
    },
    invoice_id: {
      type: 'uuid',
      notNull: true,
      references: 'invoices',
      // An invoice is money: it is never deleted, it is voided with a trace.
      onDelete: 'RESTRICT',
    },
    // Mirror of payment_submissions.status, maintained by trigger. Never write
    // it by hand: the BEFORE INSERT trigger overwrites whatever is sent.
    submission_status: { type: 'payment_submission_status', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('payment_submission_invoices', 'payment_submission_invoices_pkey', {
    primaryKey: ['submission_id', 'invoice_id'],
  });

  // The invariant, enforced where it cannot be bypassed.
  pgm.sql(`
    CREATE UNIQUE INDEX payment_submission_invoices_one_pending_per_invoice
      ON payment_submission_invoices (invoice_id)
      WHERE submission_status = 'pending'
  `);

  // Reading "what does this pending payment reserve" by driver.
  pgm.createIndex('payment_submission_invoices', 'invoice_id');

  // The status is copied from the parent on insert, so a caller cannot lie.
  pgm.sql(`
    CREATE FUNCTION payment_submission_invoices_set_status() RETURNS trigger AS $$
    BEGIN
      SELECT status INTO NEW.submission_status
        FROM payment_submissions WHERE id = NEW.submission_id;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER payment_submission_invoices_set_status
      BEFORE INSERT ON payment_submission_invoices
      FOR EACH ROW EXECUTE FUNCTION payment_submission_invoices_set_status();
  `);

  // ...and follows the parent afterwards, which is what frees the reservation
  // when a payment is approved, rejected or reverted.
  pgm.sql(`
    CREATE FUNCTION payment_submissions_sync_invoice_status() RETURNS trigger AS $$
    BEGIN
      UPDATE payment_submission_invoices
         SET submission_status = NEW.status
       WHERE submission_id = NEW.id;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER payment_submissions_sync_invoice_status
      AFTER UPDATE OF status ON payment_submissions
      FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION payment_submissions_sync_invoice_status();
  `);

  // Backfill from the JSON, ignoring ids that no longer point at an invoice —
  // exactly the dangling references the blob allowed. The trigger fills the
  // status, and DISTINCT protects against a duplicated id inside one array.
  pgm.sql(`
    INSERT INTO payment_submission_invoices (submission_id, invoice_id, submission_status)
    SELECT DISTINCT ps.id, i.id, ps.status
    FROM payment_submissions ps
    CROSS JOIN LATERAL jsonb_array_elements_text(ps.context->'invoiceIds') AS raw(value)
    JOIN invoices i ON i.id = raw.value::uuid
    WHERE jsonb_typeof(ps.context->'invoiceIds') = 'array'
  `);

  // The JSON key is deliberately NOT dropped here. Production still runs the
  // previous build, which reads `context->'invoiceIds'`, and dev and prod share
  // one database: removing it now would break live partial payments. This is the
  // EXPAND half — the table becomes the source of truth and the new code keeps
  // writing the JSON as a compatibility mirror. The CONTRACT half (dropping the
  // key and the mirror) is a follow-up migration once this build is deployed.
};

exports.down = (pgm) => {
  // Put the array back where it was before dropping the table.
  pgm.sql(`
    UPDATE payment_submissions ps
       SET context = COALESCE(ps.context, '{}'::jsonb) || jsonb_build_object('invoiceIds', x.ids)
      FROM (
        SELECT submission_id, jsonb_agg(invoice_id::text) AS ids
        FROM payment_submission_invoices GROUP BY submission_id
      ) x
     WHERE x.submission_id = ps.id
  `);
  pgm.sql('DROP TRIGGER IF EXISTS payment_submissions_sync_invoice_status ON payment_submissions');
  pgm.sql('DROP FUNCTION IF EXISTS payment_submissions_sync_invoice_status()');
  pgm.sql(
    'DROP TRIGGER IF EXISTS payment_submission_invoices_set_status ON payment_submission_invoices',
  );
  pgm.sql('DROP FUNCTION IF EXISTS payment_submission_invoices_set_status()');
  pgm.dropTable('payment_submission_invoices');
};
