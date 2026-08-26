import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { removeDriver } from './helpers/db-fixtures.js';

/**
 * The driver session (proposal: docs/proposals/ubicacion-afiliados, fase 2).
 *
 * The app has to stay logged in across days, or location reporting dies every
 * night. The token is therefore long-lived — and a long-lived JWT cannot be
 * revoked by expiry, so what actually cuts somebody off is the guard checking
 * the account on every request. These tests are that guarantee.
 *
 * Every driver here is created and deleted by the test itself: the database is
 * shared with production.
 */

let app: FastifyInstance;
let pool: pg.Pool;

before(async () => {
  app = await buildApp();
  pool = app.db;
});

after(async () => {
  await app.close();
});

async function makeDriver(tag: string, status = 'approved'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name)
     VALUES ('TEST', $1, $2) RETURNING id`,
    [tag, `TEST ${tag}`],
  );
  const id = rows[0]!.id;
  await pool.query(
    `INSERT INTO drivers (user_id, source, status, is_available, tariff_start_set_at)
     VALUES ($1, 'admin', $2::driver_status, true, now())`,
    [id, status],
  );
  return id;
}

const tokenFor = (id: string): string => app.jwt.sign({ sub: id, type: 'driver' });

const callMe = (token: string) =>
  app.inject({
    method: 'GET',
    url: '/api/v1/driver-auth/me',
    headers: { authorization: `Bearer ${token}` },
  });

test('the driver session is issued long, not for eight hours', async () => {
  const driverId = await makeDriver('SessionLength');
  try {
    // Signed the way the login signs it.
    const token = app.jwt.sign(
      { sub: driverId, type: 'driver' },
      { expiresIn: app.config.DRIVER_JWT_EXPIRES_IN },
    );
    const decoded = app.jwt.decode<{ exp: number; iat: number }>(token);
    const days = (decoded!.exp - decoded!.iat) / 86400;

    // The exact number is configuration; what matters is that it outlives a
    // night, which is what killed reporting before.
    assert.ok(days > 7, `la sesión del chofer debería durar días, dura ${days.toFixed(1)}`);
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('the admin session stays short — a panel on a shared machine', async () => {
  // Nothing to clean up: this only reads configuration.
  assert.equal(app.config.JWT_EXPIRES_IN, '8h');
  assert.notEqual(
    app.config.DRIVER_JWT_EXPIRES_IN,
    app.config.JWT_EXPIRES_IN,
    'alargar la sesión del chofer NO debe alargar la del admin',
  );
});

test('suspending a driver cuts him off at once, token still valid', async () => {
  const driverId = await makeDriver('SessionSuspend');
  try {
    const token = tokenFor(driverId);
    assert.equal((await callMe(token)).statusCode, 200, 'antes de suspender debería entrar');

    await pool.query(`UPDATE drivers SET status = 'suspended' WHERE user_id = $1`, [driverId]);

    const after = await callMe(token);
    // 403, not 401: the session is fine, the account is not.
    assert.equal(after.statusCode, 403, 'el MISMO token debe dejar de servir al suspenderlo');
    assert.match(JSON.parse(after.body).message, /suspendida/i);
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('suspending the USER account cuts him off too', async () => {
  const driverId = await makeDriver('SessionUserSuspend');
  try {
    const token = tokenFor(driverId);
    await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [driverId]);
    assert.equal((await callMe(token)).statusCode, 403);
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('a penalized driver STILL gets in: the app is where he pays', async () => {
  const driverId = await makeDriver('SessionPenalized', 'penalized');
  try {
    // Decision 2026-08-18. Locking him out would leave him penalized with no way
    // out, because the app is the only screen where he can see and pay his debt.
    assert.equal((await callMe(tokenFor(driverId))).statusCode, 200);
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('a rejected applicant STILL gets in: he has to read why', async () => {
  const driverId = await makeDriver('SessionRejected', 'rejected');
  try {
    // And an admin may reopen his solicitud. A door with no way out is a bug.
    assert.equal((await callMe(tokenFor(driverId))).statusCode, 200);
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('a token whose account no longer exists stops working', async () => {
  const driverId = await makeDriver('SessionGone');
  const token = tokenFor(driverId);
  await removeDriver(pool, driverId);

  const res = await callMe(token);
  // 401: there is nothing to suspend, the account is simply gone.
  assert.equal(res.statusCode, 401);
});
