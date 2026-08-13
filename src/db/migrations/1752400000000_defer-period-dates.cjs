/* eslint-disable camelcase */

/**
 * Defer tariff period dates to the tariff start (solicitudes-app, 2026-08-11).
 *
 * Business rule: until the admin SETS the tariff start (startTariff /
 * `enrollment.approve`), a subscription week must carry NO anchored dates — only
 * the registration (`created_at`) and payment (`paid_at`) dates exist. Anchoring a
 * provisional Monday beforehand and re-anchoring it at the start was the root of a
 * class of bugs (a scheduler / the UI reading the placeholder before the start was
 * set). Making `period_start`/`period_end` nullable lets `enrollOnClient` /
 * `enrollDebtOnClient` create the weeks WITHOUT dates; `enrollment.approve` anchors
 * them when the start is set.
 */

exports.up = (pgm) => {
  pgm.alterColumn('subscription_payments', 'period_start', { notNull: false });
  pgm.alterColumn('subscription_payments', 'period_end', { notNull: false });
};

exports.down = (pgm) => {
  // Backfill any unanchored rows before restoring NOT NULL (a placeholder window).
  pgm.sql(
    `UPDATE subscription_payments SET period_start = created_at WHERE period_start IS NULL`,
  );
  pgm.sql(
    `UPDATE subscription_payments
        SET period_end = COALESCE(period_start, created_at) + interval '7 days'
      WHERE period_end IS NULL`,
  );
  pgm.alterColumn('subscription_payments', 'period_start', { notNull: true });
  pgm.alterColumn('subscription_payments', 'period_end', { notNull: true });
};
