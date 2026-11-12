/* eslint-disable camelcase */

/**
 * Identity verification photos (decision by Luis, 2026-11-09/12): a selfie
 * taken with the FRONT camera plus the cédula front and back, mandatory for
 * affiliates AND passengers.
 *
 * Why a table of its own and not more rows in `documents`:
 * - The photos belong to the PERSON, not to a role. Someone who is both an
 *   affiliate and a passenger takes them once; `documents` hangs off the
 *   driver and its catalogue (`requirements`) only knows drivers and vehicles.
 * - The set is fixed (three kinds) and code-defined, while `requirements` is a
 *   catalogue the office edits — mixing them would let an admin "delete" the
 *   selfie from the requirements screen.
 *
 * History is kept, never overwritten: a retake marks the previous row as
 * `superseded_at` and inserts a new one. Exactly ONE current photo per person
 * and kind, guaranteed by the partial unique index, not by the service.
 *
 * `identity_required_enabled` ships OFF: the rule "only an approved identity
 * works" would pause every affiliate before the APK that can take the photos is
 * in their hands. The office flips it from Configuración once it is.
 *
 * PG15 (Supabase) allows ALTER TYPE ... ADD VALUE inside a transaction as long
 * as the new value is not USED in the same transaction - it isn't here.
 */

exports.up = (pgm) => {
  pgm.createType('identity_photo_kind', ['selfie', 'id_front', 'id_back']);
  pgm.createType('identity_photo_status', ['pending', 'approved', 'rejected']);

  pgm.createTable('identity_photos', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    kind: { type: 'identity_photo_kind', notNull: true },
    // A PATH in the private bucket, never a public link (regla 3).
    file_path: { type: 'text', notNull: true },
    status: { type: 'identity_photo_status', notNull: true, default: 'pending' },
    rejection_reason: { type: 'text' },
    reviewed_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    reviewed_at: { type: 'timestamptz' },
    // Set when a retake replaces this photo; NULL = the current one.
    superseded_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('identity_photos', 'identity_photos_reason_when_rejected', {
    check: "status <> 'rejected' OR rejection_reason IS NOT NULL",
  });

  pgm.createIndex('identity_photos', ['user_id', 'kind'], {
    unique: true,
    where: 'superseded_at IS NULL',
    name: 'identity_photos_one_current',
  });
  // The office's review queue: current photos still waiting for a decision.
  pgm.createIndex('identity_photos', 'created_at', {
    where: "superseded_at IS NULL AND status = 'pending'",
    name: 'identity_photos_pending_idx',
  });

  pgm.sql(`ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'identity_verified'`);
  pgm.sql(`ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'identity_photo_rejected'`);

  pgm.sql(`
    INSERT INTO app_settings (key, value, description) VALUES
    ('identity_required_enabled', 'false',
     'Verificación de identidad: cuando está encendido, un afiliado solo puede ponerse activo (y una solicitud solo se aprueba) con sus tres fotos APROBADAS. Encenderlo cuando el APK que toma las fotos ya esté repartido')
    ON CONFLICT (key) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM app_settings WHERE key = 'identity_required_enabled'`);
  pgm.dropTable('identity_photos');
  pgm.dropType('identity_photo_status');
  pgm.dropType('identity_photo_kind');
  // notification_type values cannot be dropped in PostgreSQL; unused values are harmless.
};
