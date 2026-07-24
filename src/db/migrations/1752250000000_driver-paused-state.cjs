/* eslint-disable camelcase */

/**
 * Driver-status redesign - Fase A (spec: docs/proposals/estados-del-chofer).
 *
 * Adds the administrative `paused` state (licencia: the admin pauses a driver
 * with zero debt; the tariff is frozen while paused). `approved` stays as the
 * healthy base state - NO enum backfill. `overdue`/`penalized` belong to Fase B
 * (the debt engine of the tarifa-penalizacion proposal) and are NOT added here.
 *
 * `is_available` becomes the voluntary availability plane (active/inactive),
 * orthogonal to the status enum: approved drivers default to available.
 *
 * `paused_at` records when an administrative pause started so `resume` can shift
 * the frozen tariff windows forward by the pause duration (moving-window model;
 * the v8 weekly model will re-anchor to Monday 00:00 in Fase B).
 *
 * PG15 (Supabase) allows ALTER TYPE ... ADD VALUE inside a transaction as long
 * as the new value is not USED in the same transaction - it isn't here.
 */

exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE driver_status ADD VALUE IF NOT EXISTS 'paused'`);

  // Availability plane: approved drivers are available by default.
  pgm.alterColumn('drivers', 'is_available', { default: true });
  pgm.sql(`UPDATE drivers SET is_available = true WHERE status = 'approved'`);

  // Freeze anchor for the administrative pause (null = not paused).
  pgm.addColumn('drivers', { paused_at: { type: 'timestamptz' } });
};

exports.down = (pgm) => {
  pgm.dropColumn('drivers', 'paused_at');
  pgm.alterColumn('drivers', 'is_available', { default: false });
  // NOTE: PostgreSQL cannot DROP a value from an enum, so `paused` stays in
  // driver_status. Harmless once the column revert above is applied.
};
