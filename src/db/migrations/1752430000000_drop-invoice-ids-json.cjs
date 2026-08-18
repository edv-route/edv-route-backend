/* eslint-disable camelcase */

/**
 * CONTRACT half of migration `1752420000000` (2026-08-18).
 *
 * The build that reads `payment_submission_invoices` is now in production, so
 * the JSON mirror in `payment_submissions.context->'invoiceIds'` has no readers
 * left. It goes away: two copies of the same fact is how they drift apart, and
 * the JSON is the one no constraint can police.
 *
 * The relation stays as the single source of truth. Nothing is lost — the
 * expand migration copied every id that pointed at a real invoice, and the
 * deploy re-ran the backfill to catch anything written in between.
 */

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE payment_submissions
       SET context = context - 'invoiceIds'
     WHERE context ? 'invoiceIds'
  `);
};

exports.down = (pgm) => {
  // Rebuild the array from the relation, so a rollback lands on a database the
  // previous build can still read.
  pgm.sql(`
    UPDATE payment_submissions ps
       SET context = COALESCE(ps.context, '{}'::jsonb) || jsonb_build_object('invoiceIds', x.ids)
      FROM (
        SELECT submission_id, jsonb_agg(invoice_id::text) AS ids
        FROM payment_submission_invoices GROUP BY submission_id
      ) x
     WHERE x.submission_id = ps.id
  `);
};
