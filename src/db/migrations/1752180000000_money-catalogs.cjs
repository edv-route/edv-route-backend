/* eslint-disable camelcase */

/**
 * Block 2 - money catalogs (design doc v7):
 *  - memberships: THE membership (single active version; conditional versioning)
 *  - membership_benefits: benefits granted by each membership version
 *  - subscription_plans: tariff catalog (conditional versioning)
 * Payment/invoice tables arrive in block 3 (they reference drivers).
 * Invoice numbering decision (2026-07-10): single continuous sequence, no yearly reset.
 */

exports.up = (pgm) => {
  pgm.createType('billing_period', ['daily', 'weekly', 'monthly', 'annual']);

  pgm.createTable('memberships', {
    id: { type: 'integer', primaryKey: true, sequenceGenerated: { precedence: 'BY DEFAULT' } },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    price_usd: { type: 'numeric(10,2)', notNull: true },
    active: { type: 'boolean', notNull: true, default: true },
    created_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('memberships', 'memberships_price_positive', { check: 'price_usd >= 0' });
  // Physical guarantee: at most ONE active membership version platform-wide
  pgm.sql('CREATE UNIQUE INDEX memberships_single_active ON memberships ((1)) WHERE active');
  pgm.createTrigger('memberships', 'trg_memberships_updated_at', {
    when: 'BEFORE', operation: 'UPDATE', level: 'ROW', function: 'set_updated_at',
  });

  pgm.createTable('membership_benefits', {
    membership_id: {
      type: 'integer', notNull: true,
      references: 'memberships', onDelete: 'CASCADE',
    },
    benefit_id: {
      type: 'integer', notNull: true,
      references: 'benefits', onDelete: 'RESTRICT',
    },
  });
  pgm.addConstraint('membership_benefits', 'membership_benefits_pk', {
    primaryKey: ['membership_id', 'benefit_id'],
  });

  pgm.createTable('subscription_plans', {
    id: { type: 'integer', primaryKey: true, sequenceGenerated: { precedence: 'BY DEFAULT' } },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    billing_period: { type: 'billing_period', notNull: true },
    price_usd: { type: 'numeric(10,2)', notNull: true },
    // smallint[] validated against vehicle_types in the backend (null = all types)
    allowed_vehicle_types: { type: 'smallint[]' },
    active: { type: 'boolean', notNull: true, default: true },
    created_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('subscription_plans', 'subscription_plans_price_positive', {
    check: 'price_usd >= 0',
  });
  pgm.createTrigger('subscription_plans', 'trg_subscription_plans_updated_at', {
    when: 'BEFORE', operation: 'UPDATE', level: 'ROW', function: 'set_updated_at',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('subscription_plans');
  pgm.dropTable('membership_benefits');
  pgm.dropTable('memberships');
  pgm.dropType('billing_period');
};
