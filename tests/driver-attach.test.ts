import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { DriverAuthRepository } from '../src/modules/driver-auth/driver-auth.repository.js';
import { DriverAuthService } from '../src/modules/driver-auth/driver-auth.service.js';

/**
 * A CLIENT becoming an AFFILIATE (independent roles, Luis 2026-09-01), via the
 * cédula-first flow: checkCedula picks the form, and the SHORT form (attach)
 * proves it is him with his CLIENT password and brings the driver's OWN
 * email, phone and password (which land on `users`, where the driver side
 * reads them). Throwaway people, deleted afterwards — shared database.
 */

let pool: pg.Pool;
let service: DriverAuthService;

const created: string[] = [];
const stamp = Date.now();
const emailFor = (tag: string): string => `test.attach.${tag}.${stamp}@edvroute.test`;
const phoneFor = (n: number): string => `+58426${String(stamp).slice(-5)}${String(n).padStart(2, '0')}`;
const cedulaFor = (n: number): string => `V-7${String(stamp).slice(-6)}${String(n).padStart(2, '0')}`;

before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const app = {
    db: pool,
    storage: undefined,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    config: { DRIVER_JWT_EXPIRES_IN: '365d' },
    jwt: { sign: () => 'token-de-prueba' },
    httpErrors: {
      badRequest: (m: string) => Object.assign(new Error(m), { statusCode: 400 }),
      unauthorized: (m: string) => Object.assign(new Error(m), { statusCode: 401 }),
      conflict: (m: string) => Object.assign(new Error(m), { statusCode: 409 }),
      internalServerError: (m: string) => Object.assign(new Error(m), { statusCode: 500 }),
    },
  } as unknown as FastifyInstance;
  // Only the check/attach paths are exercised here; the create-new-person
  // branch (DriversService) has its own coverage and needs none of these.
  service = new DriverAuthService(
    app,
    new DriverAuthRepository(pool),
    null as never,
    null as never,
    null as never,
  );
});

after(async () => {
  for (const id of created) {
    await pool.query('DELETE FROM audit_logs WHERE actor_user_id = $1', [id]).catch((e) => {
      console.error('limpieza audit_logs falló:', id, e.message);
    });
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch((e) => {
      console.error('limpieza users falló:', id, e.message);
    });
  }
  await pool.end();
});

/** A throwaway pure CLIENT: his contact and password live on `clients`. */
async function client(tag: string, n: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name, birth_date)
     VALUES ('Prueba', $1, 'Prueba ' || $1, '1990-05-15') RETURNING id`,
    [tag],
  );
  const userId = rows[0]!.id;
  created.push(userId);
  await pool.query(
    `INSERT INTO clients (user_id, status, accepted_privacy_at, national_id, email, phone, password_hash)
     VALUES ($1, 'active', now(), $2, $3, $4, $5)`,
    [userId, cedulaFor(n), emailFor(tag), phoneFor(n), await argon2.hash('123456')],
  );
  return userId;
}

test('checkCedula picks the form on the driver side too', async () => {
  assert.deepEqual(await service.checkCedula(cedulaFor(90)), { status: 'new' });
  await client('Chequeo', 1);
  assert.deepEqual(await service.checkCedula(cedulaFor(1)), { status: 'attachable' });
});

test('the SHORT form: a client becomes an applicant with his own driver contact and password', async () => {
  const userId = await client('Feliz', 2);

  const result = await service.attach({
    nationalId: cedulaFor(2),
    currentPassword: '123456',
    email: emailFor('FelizChofer'),
    phone: phoneFor(42),
    password: '87654321',
    acceptedPrivacy: true,
  });
  assert.equal(result.driver.userId, userId, 'la MISMA persona, segundo sombrero');
  assert.equal(result.driver.status, 'applicant', 'nace como solicitud, igual que cualquiera');

  // The driver's own contact and password landed on `users`…
  const { rows } = await pool.query<{ email: string | null; hash: string | null }>(
    'SELECT email, password_hash AS hash FROM users WHERE id = $1',
    [userId],
  );
  assert.equal(rows[0]!.email, emailFor('FelizChofer'));
  assert.ok(await argon2.verify(rows[0]!.hash!, '87654321'), 'clave PROPIA del rol chofer');

  // …and his client life did not move a hair.
  const { rows: side } = await pool.query<{ status: string; email: string | null; hash: string }>(
    'SELECT status, email, password_hash AS hash FROM clients WHERE user_id = $1',
    [userId],
  );
  assert.equal(side[0]!.status, 'active');
  assert.equal(side[0]!.email, emailFor('Feliz'), 'su correo de cliente sigue siendo el suyo');
  assert.ok(await argon2.verify(side[0]!.hash, '123456'), 'su clave de cliente intacta');
});

test('without the right client password, the short form attaches nothing', async () => {
  await client('Cauto', 3);

  const bad = await service
    .attach({
      nationalId: cedulaFor(3),
      currentPassword: '999999',
      email: emailFor('CautoChofer'),
      phone: phoneFor(43),
      password: '123456',
      acceptedPrivacy: true,
    })
    .catch((e: Error) => e.message);
  const unknown = await service
    .attach({
      nationalId: cedulaFor(91),
      currentPassword: 'x',
      email: emailFor('NadieChofer'),
      phone: phoneFor(44),
      password: '123456',
      acceptedPrivacy: true,
    })
    .catch((e: Error) => e.message);
  assert.equal(bad, unknown, 'clave errada y cédula desconocida responden igual');
});

test('a rejected solicitud leaves the client side untouched (roles independientes)', async () => {
  const userId = await client('Rechazado', 5);
  await service.attach({
    nationalId: cedulaFor(5),
    currentPassword: '123456',
    email: emailFor('RechazadoChofer'),
    phone: phoneFor(45),
    password: '123456',
    acceptedPrivacy: true,
  });

  await pool.query(`UPDATE drivers SET status = 'rejected' WHERE user_id = $1`, [userId]);

  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM clients WHERE user_id = $1',
    [userId],
  );
  assert.equal(rows[0]!.status, 'active', 'rechazado como chofer, cliente como si nada');
});
