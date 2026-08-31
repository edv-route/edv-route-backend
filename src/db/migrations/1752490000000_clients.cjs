/* eslint-disable camelcase */

/**
 * The passenger side of the platform (proposal: docs/proposals/cliente).
 *
 * A client is NOT a separate kind of person: it is a `users` row with a
 * `clients` row hanging off it, exactly like `drivers`. That is the whole
 * design, and it is what makes the next sentence possible — the same human can
 * be both. An affiliate who has an accident, or whose bike is in the shop, is a
 * passenger that day; he already has his `users` row, so he only gains a
 * `clients` one.
 *
 * The table is deliberately thin. Trips, ratings and payment methods are NOT
 * here: those columns get added when the thing they describe exists. Inventing
 * them now is guessing.
 */

exports.up = (pgm) => {
  pgm.createTable('clients', {
    // Same shape as `drivers`: the user IS the identity, this only extends it.
    user_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    /**
     * `active` or `suspended`. A passenger who misbehaves has to be stoppable,
     * and text (not an enum) because the states of a client are nowhere near
     * settled — an enum would need a migration to add the first one we missed.
     */
    status: { type: 'text', notNull: true, default: 'active' },
    // Consent captured at registration, with its date. Same rule as the driver:
    // a boolean would not say WHEN, and that is the part that matters later.
    accepted_privacy_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('clients', 'clients_status_check', {
    check: "status IN ('active', 'suspended')",
  });

  pgm.createIndex('clients', 'status');

  /**
   * Phone becomes unique, because a client signs in with EITHER his email or
   * his phone (decision by Luis, 2026-08-31) and an identifier that can point
   * at two people is not an identifier.
   *
   * Partial: plenty of rows legitimately have no phone, and NULLs must not
   * collide with each other.
   *
   * Verified before writing this: zero duplicates among the existing rows, so
   * it applies without touching anybody.
   */
  pgm.createIndex('users', 'phone', {
    unique: true,
    where: 'phone IS NOT NULL',
    name: 'users_phone_unique',
  });

  pgm.createTrigger('clients', 'trg_clients_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
};

exports.down = (pgm) => {
  pgm.dropTrigger('clients', 'trg_clients_updated_at');
  pgm.dropIndex('users', 'phone', { name: 'users_phone_unique' });
  pgm.dropTable('clients');
};
