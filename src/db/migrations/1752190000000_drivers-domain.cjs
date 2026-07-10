/* eslint-disable camelcase */

/**
 * Block 3 - drivers domain (design doc v7):
 * users (own uuid + auth_user_id to link Supabase Auth later - test-mode decision
 * 2026-07-10), drivers (national_id required app-side only), vehicles, documents,
 * membership_payments, driver_subscriptions, subscription_payments,
 * invoices (single continuous number sequence - no yearly reset), audit_logs.
 */

exports.up = (pgm) => {
  // --- identity ---
  pgm.createType('user_status', ['active', 'suspended']);
  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    auth_user_id: { type: 'uuid', unique: true }, // Supabase Auth link (deferred)
    full_name: { type: 'text', notNull: true },
    email: { type: 'text', unique: true },
    phone: { type: 'text' },
    photo_url: { type: 'text' },
    status: { type: 'user_status', notNull: true, default: 'active' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTrigger('users', 'trg_users_updated_at', {
    when: 'BEFORE', operation: 'UPDATE', level: 'ROW', function: 'set_updated_at',
  });

  pgm.createType('driver_status', ['pending', 'approved', 'rejected', 'suspended']);
  pgm.createType('driver_source', ['app', 'admin']);
  pgm.createTable('drivers', {
    user_id: { type: 'uuid', primaryKey: true, references: 'users', onDelete: 'CASCADE' },
    // Required when self-registering from the app; optional via admin (decision 2026-07-10)
    national_id: { type: 'text', unique: true },
    status: { type: 'driver_status', notNull: true, default: 'pending' },
    source: { type: 'driver_source', notNull: true },
    registered_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    registration_step: { type: 'smallint' }, // wizard 1-4; null = completed
    current_vehicle_id: { type: 'uuid' }, // FK added after vehicles exists
    is_available: { type: 'boolean', notNull: true, default: false },
    avg_rating: { type: 'numeric(3,2)' },
    rating_count: { type: 'integer', notNull: true, default: 0 },
    cancel_count: { type: 'integer', notNull: true, default: 0 },
    contract_url: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTrigger('drivers', 'trg_drivers_updated_at', {
    when: 'BEFORE', operation: 'UPDATE', level: 'ROW', function: 'set_updated_at',
  });

  // --- fleet ---
  pgm.createType('vehicle_approval', ['pending', 'approved', 'rejected']);
  pgm.createTable('vehicles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    driver_id: { type: 'uuid', notNull: true, references: 'drivers', onDelete: 'CASCADE' },
    vehicle_type_id: { type: 'smallint', references: 'vehicle_types' },
    brand: { type: 'text' },
    model: { type: 'text' },
    year: { type: 'smallint' },
    color: { type: 'text' },
    plate: { type: 'text', unique: true },
    approval_status: { type: 'vehicle_approval', notNull: true, default: 'pending' },
    registered_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTrigger('vehicles', 'trg_vehicles_updated_at', {
    when: 'BEFORE', operation: 'UPDATE', level: 'ROW', function: 'set_updated_at',
  });
  pgm.addConstraint('drivers', 'drivers_current_vehicle_fk', {
    foreignKeys: {
      columns: 'current_vehicle_id',
      references: 'vehicles(id)',
      onDelete: 'SET NULL',
    },
  });

  // --- documents ---
  pgm.createType('document_status', ['valid', 'expired', 'rejected']);
  pgm.createTable('documents', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    requirement_id: { type: 'integer', notNull: true, references: 'requirements', onDelete: 'RESTRICT' },
    driver_id: { type: 'uuid', references: 'drivers', onDelete: 'CASCADE' },
    vehicle_id: { type: 'uuid', references: 'vehicles', onDelete: 'CASCADE' },
    file_url: { type: 'text' }, // Supabase Storage (upload deferred in test mode)
    expires_at: { type: 'date' },
    status: { type: 'document_status', notNull: true, default: 'valid' },
    uploaded_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('documents', 'documents_exactly_one_owner', {
    check: '(driver_id IS NULL) <> (vehicle_id IS NULL)',
  });
  pgm.createTrigger('documents', 'trg_documents_updated_at', {
    when: 'BEFORE', operation: 'UPDATE', level: 'ROW', function: 'set_updated_at',
  });

  // --- invoicing (continuous global sequence, decision 2026-07-10) ---
  pgm.createSequence('invoice_number_seq', { type: 'bigint', start: 1 });
  pgm.createType('invoice_status', ['issued', 'voided']);
  pgm.createTable('invoices', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    invoice_number: {
      type: 'bigint', notNull: true, unique: true,
      default: pgm.func("nextval('invoice_number_seq')"),
    },
    driver_id: { type: 'uuid', notNull: true, references: 'drivers', onDelete: 'RESTRICT' },
    issued_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    total_usd: { type: 'numeric(10,2)', notNull: true },
    status: { type: 'invoice_status', notNull: true, default: 'issued' },
    voided_at: { type: 'timestamptz' },
    voided_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    registered_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // --- membership payment (single lifetime payment per driver) ---
  pgm.createType('membership_payment_status', ['pending', 'paid', 'refunded']);
  pgm.createTable('membership_payments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    driver_id: { type: 'uuid', notNull: true, references: 'drivers', onDelete: 'RESTRICT' },
    membership_id: { type: 'integer', notNull: true, references: 'memberships', onDelete: 'RESTRICT' },
    invoice_id: { type: 'uuid', references: 'invoices', onDelete: 'RESTRICT' },
    amount_usd: { type: 'numeric(10,2)', notNull: true },
    status: { type: 'membership_payment_status', notNull: true, default: 'pending' },
    paid_at: { type: 'timestamptz' },
    refunded_at: { type: 'timestamptz' },
    refunded_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    registered_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // Only one non-refunded membership payment per driver
  pgm.sql(`CREATE UNIQUE INDEX membership_payments_one_valid_per_driver
           ON membership_payments (driver_id) WHERE status <> 'refunded'`);

  // --- tariff subscriptions (prepaid) ---
  pgm.createType('subscription_status', ['pending_payment', 'active', 'scheduled', 'expired', 'cancelled']);
  pgm.createTable('driver_subscriptions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    driver_id: { type: 'uuid', notNull: true, references: 'drivers', onDelete: 'RESTRICT' },
    plan_id: { type: 'integer', notNull: true, references: 'subscription_plans', onDelete: 'RESTRICT' },
    status: { type: 'subscription_status', notNull: true, default: 'pending_payment' },
    started_at: { type: 'timestamptz' },
    current_period_start: { type: 'timestamptz' },
    current_period_end: { type: 'timestamptz' },
    cancelled_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`CREATE UNIQUE INDEX driver_subscriptions_one_active
           ON driver_subscriptions (driver_id) WHERE status = 'active'`);
  pgm.sql(`CREATE UNIQUE INDEX driver_subscriptions_one_scheduled
           ON driver_subscriptions (driver_id) WHERE status = 'scheduled'`);
  pgm.createTrigger('driver_subscriptions', 'trg_driver_subscriptions_updated_at', {
    when: 'BEFORE', operation: 'UPDATE', level: 'ROW', function: 'set_updated_at',
  });

  pgm.createType('subscription_payment_status', ['pending', 'paid', 'overdue', 'refunded']);
  pgm.createTable('subscription_payments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    driver_subscription_id: {
      type: 'uuid', notNull: true,
      references: 'driver_subscriptions', onDelete: 'RESTRICT',
    },
    invoice_id: { type: 'uuid', references: 'invoices', onDelete: 'RESTRICT' },
    period_start: { type: 'timestamptz', notNull: true },
    period_end: { type: 'timestamptz', notNull: true },
    amount_usd: { type: 'numeric(10,2)', notNull: true },
    status: { type: 'subscription_payment_status', notNull: true, default: 'pending' },
    paid_at: { type: 'timestamptz' },
    refunded_at: { type: 'timestamptz' },
    refunded_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    registered_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // --- audit ---
  pgm.createTable('audit_logs', {
    id: { type: 'bigint', primaryKey: true, sequenceGenerated: { precedence: 'BY DEFAULT' } },
    actor_admin_id: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    actor_user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    event_type: { type: 'text', notNull: true },
    entity: { type: 'text', notNull: true },
    entity_id: { type: 'text' },
    data: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('audit_logs', 'audit_logs_max_one_actor', {
    check: 'NOT (actor_admin_id IS NOT NULL AND actor_user_id IS NOT NULL)',
  });
  pgm.createIndex('audit_logs', ['entity', 'entity_id']);
  pgm.createIndex('audit_logs', 'created_at');
};

exports.down = (pgm) => {
  pgm.dropTable('audit_logs');
  pgm.dropTable('subscription_payments');
  pgm.dropTable('driver_subscriptions');
  pgm.dropTable('membership_payments');
  pgm.dropTable('invoices');
  pgm.dropSequence('invoice_number_seq');
  pgm.dropTable('documents');
  pgm.dropConstraint('drivers', 'drivers_current_vehicle_fk');
  pgm.dropTable('vehicles');
  pgm.dropTable('drivers');
  pgm.dropTable('users');
  pgm.dropType('subscription_payment_status');
  pgm.dropType('subscription_status');
  pgm.dropType('membership_payment_status');
  pgm.dropType('invoice_status');
  pgm.dropType('document_status');
  pgm.dropType('vehicle_approval');
  pgm.dropType('driver_source');
  pgm.dropType('driver_status');
  pgm.dropType('user_status');
};
