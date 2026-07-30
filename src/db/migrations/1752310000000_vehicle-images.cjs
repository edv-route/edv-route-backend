/* eslint-disable camelcase */

/**
 * Vehicle images (up to 3 per vehicle). Photos of the affiliate's vehicles,
 * shown as catalog cards. The binary lives in the private Supabase bucket
 * (file_url = storage key); Postgres only keeps the reference, like documents.
 * `position` (1-3) gives ordering; UNIQUE(vehicle_id, position) also caps the
 * count at three without a counter.
 */

exports.up = (pgm) => {
  pgm.createTable('vehicle_images', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    vehicle_id: { type: 'uuid', notNull: true, references: 'vehicles', onDelete: 'CASCADE' },
    file_url: { type: 'text', notNull: true }, // storage key in the private bucket
    position: { type: 'smallint', notNull: true },
    uploaded_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('vehicle_images', 'vehicle_images_position_range', {
    check: 'position BETWEEN 1 AND 3',
  });
  pgm.addConstraint('vehicle_images', 'vehicle_images_vehicle_position_uniq', {
    unique: ['vehicle_id', 'position'],
  });
};

exports.down = (pgm) => {
  pgm.dropTable('vehicle_images');
};
