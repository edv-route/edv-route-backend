/* eslint-disable camelcase */

/**
 * Personal data for real-world affiliates (business feedback 2026-07-16):
 * structured name (first/last required, middles optional), birth date and
 * home address. `full_name` STAYS and is composed by the backend on every
 * write - it feeds every listing/audit/invoice query untouched.
 * national_id keeps its single column (canonical "V-12345678"); phone keeps
 * its column (canonical E.164 "+58..."): both are format decisions, not schema.
 */

exports.up = (pgm) => {
  pgm.addColumns('users', {
    first_name: { type: 'text' },
    middle_name: { type: 'text' },
    last_name: { type: 'text' },
    second_last_name: { type: 'text' },
    birth_date: { type: 'date' },
    address: { type: 'text' },
  });

  // Best-effort backfill from full_name so NOT NULL can be enforced
  // (no-op on an empty table):
  // 2 tokens -> first/last · 3 -> first/last/second_last (Venezuelan usage)
  // 4+ -> first/middle/last/second_last · 1 -> everything as first, last '—'
  pgm.sql(`
    UPDATE users SET
      first_name = parts[1],
      middle_name = CASE WHEN cardinality(parts) >= 4 THEN parts[2] END,
      last_name = CASE
        WHEN cardinality(parts) = 1 THEN '—'
        WHEN cardinality(parts) = 2 THEN parts[2]
        WHEN cardinality(parts) = 3 THEN parts[2]
        ELSE parts[3]
      END,
      second_last_name = CASE
        WHEN cardinality(parts) = 3 THEN parts[3]
        WHEN cardinality(parts) >= 4 THEN array_to_string(parts[4:], ' ')
      END
    FROM (SELECT id AS uid, regexp_split_to_array(btrim(full_name), '\\s+') AS parts FROM users) s
    WHERE users.id = s.uid
  `);

  pgm.alterColumn('users', 'first_name', { notNull: true });
  pgm.alterColumn('users', 'last_name', { notNull: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('users', [
    'first_name',
    'middle_name',
    'last_name',
    'second_last_name',
    'birth_date',
    'address',
  ]);
};
