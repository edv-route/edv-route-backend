/**
 * Allow MULTIPLE pending payment submissions per driver (2026-08-12): the admin
 * can register separate partial payments — each covering DIFFERENT invoices —
 * while earlier ones are still under review. Drops the "one pending per driver"
 * unique index; the double-charge guard moves to the service, where a new payment
 * may only cover invoices NOT already reserved by another pending submission.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS payment_submissions_one_pending_per_driver');
};

exports.down = (pgm) => {
  pgm.sql(`CREATE UNIQUE INDEX payment_submissions_one_pending_per_driver
           ON payment_submissions (driver_id) WHERE status = 'pending'`);
};
