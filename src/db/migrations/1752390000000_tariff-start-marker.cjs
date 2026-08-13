/* eslint-disable camelcase */

/**
 * Tariff start marker - desacople del arranque (proposal: solicitudes-app, Q2).
 *
 * Approving an app solicitud promotes the driver to `approved` WITH base debt but
 * WITHOUT starting his tariff: the tariff start is now a separate admin action
 * ("Establecer inicio"). `tariff_start_set_at` marks whether that decision has been
 * made: NULL = not set yet (the profile shows the highlighted tariff card and the
 * debt engine MUST ignore this driver - no weekly charges, no arrears, until the
 * admin sets the start). A timestamp = the start was set (startTariff anchored the
 * subscription).
 *
 * Backfill: affiliates past the applicant/pending gate already had their tariff
 * anchored at approval under the old model, so mark their start as set.
 */

exports.up = (pgm) => {
  pgm.addColumn('drivers', {
    tariff_start_set_at: { type: 'timestamptz' },
  });
  pgm.sql(
    `UPDATE drivers SET tariff_start_set_at = now()
      WHERE status::text NOT IN ('applicant', 'pending', 'rejected')`,
  );
};

exports.down = (pgm) => {
  pgm.dropColumn('drivers', 'tariff_start_set_at');
};
