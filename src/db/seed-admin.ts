import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import pg from 'pg';
import { loadConfig } from '../config/env.js';

/**
 * Creates the first admin account (username: admin) if none exists.
 * Password comes from SEED_ADMIN_PASSWORD or is generated and printed once.
 * Usage: npm run seed:admin
 */
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });

const { rows } = await pool.query('SELECT count(*)::int AS count FROM admins');
if (rows[0].count > 0) {
  console.log('An admin account already exists - nothing to seed.');
  await pool.end();
  process.exit(0);
}

const password = process.env['SEED_ADMIN_PASSWORD'] ?? randomBytes(9).toString('base64url');
const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

await pool.query(
  `INSERT INTO admins (username, full_name, password_hash) VALUES ($1, $2, $3)`,
  ['admin', 'Administrador Principal', passwordHash],
);
await pool.end();

console.log('First admin created:');
console.log('  username: admin');
console.log(`  password: ${password}`);
console.log('Change this password after the first login.');
