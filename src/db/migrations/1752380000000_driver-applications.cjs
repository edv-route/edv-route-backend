/* eslint-disable camelcase */

/**
 * App applications - solicitud vs afiliado (proposal: docs/proposals/solicitudes-app).
 *
 * The app registration is split from affiliation. A self-registration from the app now
 * lands as an `applicant` (a "solicitud") on the SHARED drivers table (Plan B: no separate
 * table), kept apart from real affiliates until an admin reviews its documentation.
 * Approving the solicitud promotes the driver STRAIGHT to `approved` WITH his base debt
 * (membership + 1 week) - the app channel no longer requires debt 0 to be approved (D6).
 *
 * Per-document review: documents gain an approval axis of their own (`document_approval`),
 * separate from the validity axis (`document_status`, now inert - D10). A solicitud cannot
 * be approved until every required document AND vehicle is `approved`. Documents uploaded
 * from the app are born `pending` (to review); the admin is the authority, so documents he
 * uploads are set `approved` in code. `reviewed_by`/`reviewed_at` keep the review trail;
 * `rejection_reason` is shown to the applicant so he can fix and resubmit.
 *
 * Backfill: `approval_status` defaults to `pending` (fail-safe: unreviewed never counts as
 * approved), so pre-existing documents - which belong to affiliates already accepted under
 * the old model - are backfilled to `approved`.
 *
 * Consent (D11): privacy is accepted at registration (step 1), terms at payment; both stored
 * as timestamps on drivers for an audit trail.
 *
 * NOTE: the "tariff start not set" marker (desacople del arranque, Q2) is DEFERRED to its own
 * migration, alongside the `start-tariff` endpoint where subscription anchoring is reworked.
 *
 * PG15 (Supabase) allows ALTER TYPE ... ADD VALUE inside a transaction as long as the new
 * value is not USED in the same transaction - `applicant` isn't used here. Creating the new
 * `document_approval` type and using its values in the same transaction is fine (that
 * restriction only applies to ADD VALUE on an existing enum, not to a fresh CREATE TYPE).
 */

exports.up = (pgm) => {
  // Solicitud state on the shared drivers table.
  pgm.sql(`ALTER TYPE driver_status ADD VALUE IF NOT EXISTS 'applicant'`);

  // Per-document approval axis (separate from the now-inert validity `document_status`).
  pgm.createType('document_approval', ['pending', 'approved', 'rejected']);
  pgm.addColumn('documents', {
    approval_status: { type: 'document_approval', notNull: true, default: 'pending' },
    rejection_reason: { type: 'text' }, // shown to the applicant on rejection
    reviewed_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    reviewed_at: { type: 'timestamptz' },
  });
  // Pre-existing documents belong to already-accepted affiliates -> mark them approved.
  pgm.sql(`UPDATE documents SET approval_status = 'approved'`);

  // Rejection reason for vehicles (they already carry `approval_status`, default pending).
  pgm.addColumn('vehicles', {
    rejection_reason: { type: 'text' },
  });

  // Consent trail: privacy at step 1, terms at payment (null = not accepted yet).
  pgm.addColumn('drivers', {
    accepted_privacy_at: { type: 'timestamptz' },
    accepted_terms_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('drivers', ['accepted_privacy_at', 'accepted_terms_at']);
  pgm.dropColumn('vehicles', 'rejection_reason');
  pgm.dropColumn('documents', ['approval_status', 'rejection_reason', 'reviewed_by', 'reviewed_at']);
  pgm.dropType('document_approval');
  // NOTE: PostgreSQL cannot DROP a value from an enum, so `applicant` stays in
  // driver_status. Harmless; no column default references it.
};
