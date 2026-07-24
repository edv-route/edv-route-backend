/* eslint-disable camelcase */

/**
 * Driver app credentials (decision 2026-07-16): login = national_id +
 * password, own auth consistent with admins (argon2id; Supabase Auth stays
 * postponed, auth_user_id remains for an eventual migration).
 * NULL = the user cannot log into the app yet.
 */

exports.up = (pgm) => {
  pgm.addColumns('users', {
    password_hash: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('users', ['password_hash']);
};
