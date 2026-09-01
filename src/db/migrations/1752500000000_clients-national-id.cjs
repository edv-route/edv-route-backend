/* eslint-disable camelcase */

/**
 * The client's cédula (decision by Luis, 2026-08-31): the passenger
 * registration now asks for the SAME fields as the affiliate's, and the cédula
 * and birth date become mandatory (only middle name, second last name and
 * address stay optional).
 *
 * Why the column lives on `clients` and NOT on `users` or `drivers`:
 * the affiliate's cédula (`drivers.national_id`) is identity the office
 * VERIFIED against his documents; the client's is SELF-DECLARED at sign-up.
 * Those are different trust levels, and one shared column would erase the
 * difference. A person who is both keeps the verified one on `drivers` (a
 * client attaching to an affiliate account does not write here), and the API
 * presents them unified with COALESCE(d.national_id, c.national_id).
 *
 * Nullable on purpose: clients registered before this rule (and
 * affiliate-clients, whose cédula lives on `drivers`) have no value here.
 * Mandatory-ness is enforced at registration, not retroactively.
 */

exports.up = (pgm) => {
  pgm.addColumn('clients', {
    national_id: { type: 'text' },
  });

  // Two DIFFERENT passengers must not claim the same cédula. Partial so the
  // legitimate NULLs (legacy rows, affiliate-clients) never collide. The
  // cross-table check against drivers' cédulas lives in the service — a
  // constraint cannot span tables.
  pgm.createIndex('clients', 'national_id', {
    unique: true,
    where: 'national_id IS NOT NULL',
    name: 'clients_national_id_unique',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('clients', 'national_id', { name: 'clients_national_id_unique' });
  pgm.dropColumn('clients', 'national_id');
};
