/* eslint-disable camelcase */

/**
 * Password recovery for the driver app ("olvide mi clave", 2026-08-24).
 *
 * The driver proves he owns the account in two steps: national id + email must
 * BOTH match a single user, and then a 6-digit code sent to that email. This
 * table is the state of one such attempt.
 *
 * The code is stored HASHED, never in clear text. A recovery code is a
 * temporary password: a leaked backup or a careless log line should not hand
 * anyone an account. Same argon2id already used for real passwords - the codes
 * are short-lived and low volume, so the cost is irrelevant here.
 *
 * The row is the whole state machine. There is no `status` column because every
 * question has an authoritative answer already: expired = `expires_at` passed,
 * spent = `used_at` set, verified = `verified_at` set, out of tries =
 * `attempts` at the cap. A status column would be a second opinion able to
 * disagree with all four.
 */

exports.up = (pgm) => {
  pgm.createTable('password_reset_codes', {
    id: {
      type: 'bigint',
      primaryKey: true,
      sequenceGenerated: { precedence: 'BY DEFAULT' },
    },
    // CASCADE mirrors `notifications`: the applicant cleanup deletes users, and
    // a half-finished recovery attempt is not history worth orphaning.
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    code_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    // Wrong tries so far. The cap lives in the service (3): a 6-digit code with
    // unlimited attempts is a 6-digit code anyone can guess.
    attempts: { type: 'smallint', notNull: true, default: 0 },
    // Set when the right code is entered. From here the attempt authorises the
    // password change and nothing else.
    verified_at: { type: 'timestamptz' },
    // Set when the password is actually changed. One attempt, one password.
    used_at: { type: 'timestamptz' },
    // Kept for the audit trail and to rate-limit by origin, never to identify
    // the driver (the token/row does that).
    requested_ip: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // The only lookup that runs on every step: the driver's live attempt, newest
  // first. Also serves the rate-limit count (how many did he ask for lately).
  pgm.createIndex('password_reset_codes', ['user_id', 'created_at'], {
    name: 'password_reset_codes_user_recent_idx',
  });

  // At most ONE live attempt per driver. Asking for a new code invalidates the
  // previous one (the service spends it), so this is the guarantee that a race
  // cannot leave two valid codes for the same account - the kind of invariant
  // that must not depend on every future caller remembering it.
  pgm.createIndex('password_reset_codes', ['user_id'], {
    name: 'password_reset_codes_one_live_per_user',
    unique: true,
    where: 'used_at IS NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('password_reset_codes');
};
