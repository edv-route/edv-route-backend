/* eslint-disable camelcase */

/**
 * Payment approval flow (v9): money-in is no longer settled on the spot.
 *
 * A "payment submission" is what a driver (or an admin on his behalf) SENDS:
 * ONE payment that covers one or more charges (tariff weeks and/or membership)
 * with a single set of payer details and 1..5 receipt/bill images. It is held
 * `pending` until an admin reviews it and either APPROVES it (its charges
 * settle and the invoice materializes, carrying the payment details) or REJECTS
 * it (charges stay owed; the driver is told to send a new one). The invoice is
 * created ON APPROVAL — mirroring the existing rule "the invoice is the receipt
 * of money received". This also removes the old bug where an advance over N
 * weeks produced N invoices but the receipt/reference landed on only the first:
 * now one submission → one approval → one invoice with its proof set.
 *
 * Also adds the admin-only "Efectivo Divisa" method type (`cash_usd`): captured
 * with date + amount + up to 5 bill photos, and NEVER offered to the driver app
 * (methods with `admin_only = true` are filtered out of the app catalog).
 *
 * Full contract for the driver-app agent: docs/decisions/decisions-log.md and
 * docs/api/endpoints.md (payment submissions).
 *
 * All changes are additive. PG15 (Supabase) allows ALTER TYPE ... ADD VALUE
 * inside a transaction as long as the new value is not USED in the same
 * transaction — it isn't here (same pattern as driver_status 'paused').
 */

exports.up = (pgm) => {
  // --- "Efectivo Divisa": a new, admin-only method type ---
  pgm.sql(`ALTER TYPE payment_method_type ADD VALUE IF NOT EXISTS 'cash_usd'`);
  // Methods flagged admin_only are never exposed to the driver app catalog.
  pgm.addColumn('payment_methods', {
    admin_only: { type: 'boolean', notNull: true, default: false },
  });

  // --- The reviewable unit of money-in ---
  pgm.createType('payment_submission_status', ['pending', 'approved', 'rejected']);
  pgm.createTable('payment_submissions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    driver_id: { type: 'uuid', notNull: true, references: 'drivers', onDelete: 'RESTRICT' },
    status: { type: 'payment_submission_status', notNull: true, default: 'pending' },
    // Declared amount of the send: for cash it is the captured amount; for the
    // other methods it is the total of the charges the submission covers.
    amount_usd: { type: 'numeric(10,2)', notNull: true },
    // Payer/method details (mirror the invoice columns). The receipt(s) live in
    // payment_submission_files so cash can carry up to 5 bill photos.
    payment_method_id: { type: 'integer', references: 'payment_methods', onDelete: 'SET NULL' },
    payment_reference: { type: 'text' }, // confirmation/reference (null for cash)
    payer_bank: { type: 'text' }, // banco emisor (transfer / pago móvil)
    paid_on: { type: 'date' }, // date the payer paid
    payer_phone: { type: 'text' }, // origin phone (pago móvil)
    payer_id: { type: 'text' }, // payer document V/E/J (pago móvil)
    payer_account: { type: 'text' }, // origin email/name (zelle / binance)
    note: { type: 'text' }, // optional constancia
    // Origin + who handled it.
    source: { type: 'driver_source', notNull: true, default: 'admin' },
    submitted_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' }, // null = from the app
    reviewed_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    reviewed_at: { type: 'timestamptz' },
    rejection_reason: { type: 'text' },
    // The invoice materialized ON APPROVAL (null while pending/rejected).
    invoice_id: { type: 'uuid', references: 'invoices', onDelete: 'RESTRICT' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTrigger('payment_submissions', 'trg_payment_submissions_updated_at', {
    when: 'BEFORE', operation: 'UPDATE', level: 'ROW', function: 'set_updated_at',
  });
  pgm.createIndex('payment_submissions', 'driver_id');
  // Anti-duplicate guard: at most one pending submission per driver at a time
  // (a new send waits for the previous to be resolved).
  pgm.sql(`CREATE UNIQUE INDEX payment_submissions_one_pending_per_driver
           ON payment_submissions (driver_id) WHERE status = 'pending'`);

  // --- Receipt/bill images (1..5): a submission's proof set ---
  pgm.createTable('payment_submission_files', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    submission_id: { type: 'uuid', notNull: true, references: 'payment_submissions', onDelete: 'CASCADE' },
    storage_path: { type: 'text', notNull: true }, // private bucket key
    position: { type: 'smallint', notNull: true, default: 1 }, // 1..5 display order
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('payment_submission_files', 'submission_id');

  // --- Link existing charges to the submission that pays them ---
  // Nullable: the debt engine emits weekly charges before any submission exists;
  // a submission claims them and, on approval, they settle. On rejection the
  // link is cleared so a fresh submission can claim them again.
  pgm.addColumn('subscription_payments', {
    submission_id: { type: 'uuid', references: 'payment_submissions', onDelete: 'SET NULL' },
  });
  pgm.addColumn('membership_payments', {
    submission_id: { type: 'uuid', references: 'payment_submissions', onDelete: 'SET NULL' },
  });
  pgm.createIndex('subscription_payments', 'submission_id');
  pgm.createIndex('membership_payments', 'submission_id');
};

exports.down = (pgm) => {
  // Drop the charge links first (they reference payment_submissions).
  pgm.dropColumn('membership_payments', 'submission_id'); // cascades its index
  pgm.dropColumn('subscription_payments', 'submission_id'); // cascades its index
  pgm.dropTable('payment_submission_files');
  pgm.dropTable('payment_submissions'); // cascades its indexes + trigger
  pgm.dropType('payment_submission_status');
  pgm.dropColumn('payment_methods', 'admin_only');
  // NOTE: PostgreSQL cannot DROP a value from an enum, so 'cash_usd' stays in
  // payment_method_type. Harmless once admin_only is dropped above.
};
