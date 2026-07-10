/* eslint-disable camelcase */

/**
 * Core of the admin module (design doc v7):
 *  - set_updated_at() trigger helper reused by every table
 *  - admins: own auth (argon2id) with login lockout fields
 *  - vehicle_types: fleet catalog (seeded: moto, carro, camioneta)
 */

exports.up = (pgm) => {
  pgm.createFunction(
    'set_updated_at',
    [],
    { returns: 'trigger', language: 'plpgsql', replace: true },
    `
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    `,
  );

  pgm.createType('admin_status', ['active', 'suspended']);

  pgm.createTable('admins', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    username: { type: 'text', notNull: true, unique: true },
    email: { type: 'text', unique: true },
    full_name: { type: 'text', notNull: true },
    password_hash: { type: 'text', notNull: true },
    role: { type: 'text', notNull: true, default: 'admin' },
    status: { type: 'admin_status', notNull: true, default: 'active' },
    failed_login_attempts: { type: 'integer', notNull: true, default: 0 },
    locked_until: { type: 'timestamptz' },
    last_login_at: { type: 'timestamptz' },
    created_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Usernames are normalized to lowercase by the API; enforce it physically
  pgm.addConstraint('admins', 'admins_username_lowercase', {
    check: 'username = lower(username)',
  });

  pgm.createTrigger('admins', 'trg_admins_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  pgm.createTable('vehicle_types', {
    id: {
      type: 'smallint',
      primaryKey: true,
      sequenceGenerated: { precedence: 'BY DEFAULT' },
    },
    name: { type: 'text', notNull: true, unique: true },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTrigger('vehicle_types', 'trg_vehicle_types_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  pgm.sql("INSERT INTO vehicle_types (name) VALUES ('moto'), ('carro'), ('camioneta')");
};

exports.down = (pgm) => {
  pgm.dropTable('vehicle_types');
  pgm.dropTable('admins');
  pgm.dropType('admin_status');
  pgm.dropFunction('set_updated_at', []);
};
