/* eslint-disable camelcase */

/**
 * Approval redesign (2026-08-09): the admin approves a driver by choosing WHEN his
 * tariff starts. Option "next Monday" leaves the driver in a new `scheduled`
 * (programado) state — approved decision made, but not operative yet; a background
 * job flips him to `approved` + available on that Monday when his subscription
 * coverage begins. Option "now" keeps the existing behaviour (active at once,
 * anchored to the current week's Monday). The automatic Monday auto-approval is
 * removed; approval is always a manual choice.
 *
 * PG15 (Supabase) allows ALTER TYPE ... ADD VALUE inside a transaction as long as
 * the new value is not USED in the same transaction - it isn't here.
 */

exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE driver_status ADD VALUE IF NOT EXISTS 'scheduled'`);
};

exports.down = () => {
  // NOTE: PostgreSQL cannot DROP a value from an enum, so `scheduled` stays in
  // driver_status. Harmless; no column defaults reference it.
};
