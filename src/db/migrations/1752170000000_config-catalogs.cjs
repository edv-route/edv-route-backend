/* eslint-disable camelcase */

/**
 * Block 1 - configuration catalogs (design doc v7):
 *  - requirements: configurable required documents (is_required only blocks
 *    app-originated registration; admin-originated skips freely)
 *  - benefits: guild benefits catalog (granted per membership version later)
 *  - app_settings: key/value platform settings (seeded: subscription_grace_hours)
 */

exports.up = (pgm) => {
  pgm.createType('requirement_applies_to', ['driver', 'vehicle']);

  pgm.createTable('requirements', {
    id: {
      type: 'integer',
      primaryKey: true,
      sequenceGenerated: { precedence: 'BY DEFAULT' },
    },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    applies_to: { type: 'requirement_applies_to', notNull: true },
    is_required: { type: 'boolean', notNull: true, default: false },
    active: { type: 'boolean', notNull: true, default: true },
    created_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Same document name may exist for driver and vehicle, but not duplicated within one
  pgm.addConstraint('requirements', 'requirements_name_applies_to_uq', {
    unique: ['name', 'applies_to'],
  });

  pgm.createTrigger('requirements', 'trg_requirements_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  pgm.createTable('benefits', {
    id: {
      type: 'integer',
      primaryKey: true,
      sequenceGenerated: { precedence: 'BY DEFAULT' },
    },
    name: { type: 'text', notNull: true, unique: true },
    description: { type: 'text' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTrigger('benefits', 'trg_benefits_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  pgm.createTable('app_settings', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'jsonb', notNull: true },
    description: { type: 'text' },
    updated_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTrigger('app_settings', 'trg_app_settings_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  pgm.sql(`
    INSERT INTO app_settings (key, value, description) VALUES
    ('subscription_grace_hours', '24',
     'Horas de gracia tras vencer la tarifa antes de suspender la operación del afiliado')
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('app_settings');
  pgm.dropTable('benefits');
  pgm.dropTable('requirements');
  pgm.dropType('requirement_applies_to');
};
