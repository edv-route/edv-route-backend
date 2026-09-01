/* eslint-disable camelcase */

/**
 * Per-role credentials and contact (decision by Luis, 2026-09-01): the driver
 * and the client sides of one person are independent — each holds its OWN
 * email, phone and password. What stays shared on `users` is the PERSON:
 * names, cédula (per-role columns, see clients-national-id), birth date,
 * address and photo.
 *
 * The driver side keeps living on `users` untouched (that is what the whole
 * money side reads — invoices, notices, lists — so it must not move). The
 * client side gains its own columns here, and the client-auth module switches
 * to them.
 *
 * Backfill: existing clients get a COPY of their current users values, so
 * nothing breaks for them; from then on the copies diverge freely. The users
 * values of pure clients are deliberately NOT nulled out: the deployed backend
 * still reads them until the new code ships, and a stale copy is harmless
 * (the new code never reads it for clients).
 *
 * `users_phone_unique` is dropped: it existed so the client could log in by
 * phone against `users`; that lookup moves to `clients.phone` (unique here).
 * Driver-side phones go back to their pre-clients behavior (no uniqueness),
 * and two DIFFERENT humans may now share a phone across roles — the roles are
 * independent.
 */

exports.up = (pgm) => {
  pgm.addColumn('clients', {
    email: { type: 'text' },
    phone: { type: 'text' },
    password_hash: { type: 'text' },
  });

  pgm.sql(`
    UPDATE clients c
       SET email = u.email, phone = u.phone, password_hash = u.password_hash
      FROM users u
     WHERE u.id = c.user_id
  `);

  // The client signs in with email OR phone: within clients, each must point
  // at ONE person. Case-insensitive on email (nobody types theirs the same
  // way twice); partial so NULLs never collide.
  pgm.sql(`
    CREATE UNIQUE INDEX clients_email_unique ON clients (lower(email))
     WHERE email IS NOT NULL
  `);
  pgm.createIndex('clients', 'phone', {
    unique: true,
    where: 'phone IS NOT NULL',
    name: 'clients_phone_unique',
  });

  pgm.dropIndex('users', 'phone', { name: 'users_phone_unique' });
};

exports.down = (pgm) => {
  pgm.createIndex('users', 'phone', {
    unique: true,
    where: 'phone IS NOT NULL',
    name: 'users_phone_unique',
  });
  pgm.dropIndex('clients', 'phone', { name: 'clients_phone_unique' });
  pgm.sql('DROP INDEX clients_email_unique');
  pgm.dropColumn('clients', ['email', 'phone', 'password_hash']);
};
