/* eslint-disable camelcase */

/**
 * Trainings domain (design doc v7 §5.7): guild trainings with enrollment and
 * attendance. Trainings are cancelled (status), never deleted - attendees
 * keep their history. UNIQUE(training_id, driver_id) prevents double
 * enrollment; freeing a slot is a status change to 'cancelled'.
 */

exports.up = (pgm) => {
  pgm.createType('training_status', ['scheduled', 'cancelled', 'completed']);
  pgm.createType('training_attendee_status', ['registered', 'attended', 'absent', 'cancelled']);

  pgm.createTable('trainings', {
    id: {
      type: 'integer',
      primaryKey: true,
      sequenceGenerated: { precedence: 'BY DEFAULT' },
    },
    title: { type: 'text', notNull: true },
    description: { type: 'text' },
    location: { type: 'text' },
    starts_at: { type: 'timestamptz', notNull: true },
    ends_at: { type: 'timestamptz' },
    capacity: { type: 'integer' }, // null = unlimited
    status: { type: 'training_status', notNull: true, default: 'scheduled' },
    created_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('trainings', 'trainings_capacity_positive', {
    check: 'capacity IS NULL OR capacity > 0',
  });
  pgm.addConstraint('trainings', 'trainings_ends_after_starts', {
    check: 'ends_at IS NULL OR ends_at > starts_at',
  });
  pgm.createTrigger('trainings', 'trg_trainings_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  pgm.createTable('training_attendees', {
    id: {
      type: 'bigint',
      primaryKey: true,
      sequenceGenerated: { precedence: 'BY DEFAULT' },
    },
    training_id: {
      type: 'integer',
      notNull: true,
      references: 'trainings',
      onDelete: 'RESTRICT',
    },
    driver_id: {
      type: 'uuid',
      notNull: true,
      references: { name: 'drivers', columns: 'user_id' },
      onDelete: 'RESTRICT',
    },
    status: { type: 'training_attendee_status', notNull: true, default: 'registered' },
    registered_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' }, // null = self-service (app, future)
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('training_attendees', 'training_attendees_training_driver_uq', {
    unique: ['training_id', 'driver_id'],
  });
  pgm.createIndex('training_attendees', 'driver_id');
  pgm.createTrigger('training_attendees', 'trg_training_attendees_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('training_attendees');
  pgm.dropTable('trainings');
  pgm.dropType('training_attendee_status');
  pgm.dropType('training_status');
};
