import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { ClientAuthRepository } from '../src/modules/client-auth/client-auth.repository.js';
import { ClientAuthService } from '../src/modules/client-auth/client-auth.service.js';

/**
 * The passenger side of the account (proposal: docs/proposals/cliente).
 *
 * Every test builds its own throwaway people and deletes them afterwards: the
 * database is shared with production, and `users` is shared with the driver
 * side, so a stray row here is a stray row in the affiliates list.
 *
 * Nothing here goes near the debt engine.
 */

let pool: pg.Pool;
let app: FastifyInstance;
let repo: ClientAuthRepository;
let service: ClientAuthService;

/** Ids created by this run, removed in `after` no matter how a test ended. */
const created: string[] = [];

const stamp = Date.now();
const emailFor = (tag: string): string => `test.${tag}.${stamp}@edvroute.test`;
/** Venezuelan mobile shape, as personProperties demands. */
const phoneFor = (n: number): string => `+58412${String(stamp).slice(-5)}${String(n).padStart(2, '0')}`;

before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  app = {
    db: pool,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    storage: undefined,
    config: { DRIVER_JWT_EXPIRES_IN: '365d' },
    jwt: { sign: () => 'token-de-prueba' },
    httpErrors: {
      badRequest: (m: string) => Object.assign(new Error(m), { statusCode: 400 }),
      unauthorized: (m: string) => Object.assign(new Error(m), { statusCode: 401 }),
      forbidden: (m: string) => Object.assign(new Error(m), { statusCode: 403 }),
      conflict: (m: string) => Object.assign(new Error(m), { statusCode: 409 }),
      serviceUnavailable: (m: string) => Object.assign(new Error(m), { statusCode: 503 }),
    },
  } as unknown as FastifyInstance;
  repo = new ClientAuthRepository(pool);
  service = new ClientAuthService(app, repo);
});

after(async () => {
  for (const id of created) {
    // clients cascades from users; audit rows reference the user, so they go first.
    await pool.query('DELETE FROM audit_logs WHERE actor_user_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
  }
  await pool.end();
});

function registration(tag: string, n: number) {
  return {
    firstName: 'Prueba',
    lastName: tag,
    email: emailFor(tag),
    phone: phoneFor(n),
    password: 'clave123',
    acceptedPrivacy: true,
  };
}

test('registering creates the person and their client side', async () => {
  const result = await service.register(registration('Alta', 1));
  created.push(result.client.userId);

  assert.equal(result.client.status, 'active');
  assert.equal(result.client.fullName, 'Prueba Alta', 'el nombre completo se arma de sus partes');
  assert.ok(result.token, 'debe devolver sesión: registrarse ya te deja dentro');

  // Both rows, not just the user: half an account cannot sign in anywhere.
  const { rows } = await pool.query(
    'SELECT (SELECT count(*) FROM users WHERE id = $1)::int AS u, (SELECT count(*) FROM clients WHERE user_id = $1)::int AS c',
    [result.client.userId],
  );
  assert.equal(rows[0]!.u, 1);
  assert.equal(rows[0]!.c, 1);
});

test('privacy consent is required, and it is recorded with its date', async () => {
  await assert.rejects(
    () => service.register({ ...registration('SinPriv', 2), acceptedPrivacy: false }),
    /privacidad/,
  );

  const ok = await service.register(registration('ConPriv', 3));
  created.push(ok.client.userId);
  const { rows } = await pool.query<{ acceptedPrivacyAt: Date | null }>(
    'SELECT accepted_privacy_at AS "acceptedPrivacyAt" FROM clients WHERE user_id = $1',
    [ok.client.userId],
  );
  assert.ok(rows[0]!.acceptedPrivacyAt, 'sin la fecha no sabríamos CUÁNDO aceptó');
});

test('he can sign in with his email OR his phone', async () => {
  const reg = registration('Entrar', 4);
  const created1 = await service.register(reg);
  created.push(created1.client.userId);

  const byEmail = await service.login(reg.email, reg.password);
  assert.equal(byEmail.client.userId, created1.client.userId);

  const byPhone = await service.login(reg.phone, reg.password);
  assert.equal(byPhone.client.userId, created1.client.userId, 'el teléfono vale igual que el correo');

  // Case must not matter: nobody types their own address the same way twice.
  const byUpper = await service.login(reg.email.toUpperCase(), reg.password);
  assert.equal(byUpper.client.userId, created1.client.userId);
});

test('a wrong password and an unknown account say exactly the same thing', async () => {
  const reg = registration('Malo', 5);
  const c = await service.register(reg);
  created.push(c.client.userId);

  const wrong = await service.login(reg.email, 'otraclave').catch((e: Error) => e.message);
  const unknown = await service.login('nadie.' + stamp + '@edvroute.test', 'x').catch((e: Error) => e.message);
  // Different messages would tell a stranger which addresses are registered.
  assert.equal(wrong, unknown);
});

test('an AFFILIATE registering as a client keeps his account and gains the passenger side', async () => {
  // Somebody who already exists as a driver, with his own password.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name, email, phone, password_hash)
     VALUES ('Prueba', 'Chofer', 'Prueba Chofer', $1, $2, $3) RETURNING id`,
    [emailFor('Chofer'), phoneFor(6), await argon2.hash('claveoriginal')],
  );
  const userId = rows[0]!.id;
  created.push(userId);
  await pool.query(
    `INSERT INTO drivers (user_id, source, status, national_id) VALUES ($1, 'app', 'approved', $2)`,
    [userId, `V-${String(stamp).slice(-8)}`],
  );

  const result = await service.register({
    ...registration('Chofer', 6),
    email: emailFor('Chofer'),
    phone: phoneFor(6),
    password: 'claveNUEVA',
  });

  assert.equal(result.client.userId, userId, 'es la MISMA persona, no una cuenta nueva');
  assert.ok(result.client.nationalId, 'sigue siendo afiliado: conserva su cédula');

  // His password was NOT replaced by the one typed on the passenger form.
  const stored = await repo.findPasswordHash(userId);
  assert.ok(await argon2.verify(stored!, 'claveoriginal'), 'su clave de chofer no se toca');

  // And there is exactly one user row: no duplicate person.
  const { rows: count } = await pool.query(
    'SELECT count(*)::int AS n FROM users WHERE email = $1',
    [emailFor('Chofer')],
  );
  assert.equal(count[0]!.n, 1);
});

test('registering twice as a client is refused', async () => {
  const reg = registration('Doble', 7);
  const first = await service.register(reg);
  created.push(first.client.userId);

  await assert.rejects(() => service.register(reg), /Ya existe una cuenta/);
});

test('editing his data updates the full name and rejects a taken email', async () => {
  const mine = await service.register(registration('Editar', 8));
  const other = await service.register(registration('Otro', 9));
  created.push(mine.client.userId, other.client.userId);

  const updated = await service.updateProfile(mine.client.userId, {
    lastName: 'Apellido',
    address: 'Naguanagua',
  });
  assert.equal(updated.fullName, 'Prueba Apellido', 'el nombre completo se rehace solo');
  assert.equal(updated.address, 'Naguanagua');

  await assert.rejects(
    () => service.updateProfile(mine.client.userId, { email: other.client.email! }),
    /ya pertenece a otra cuenta/,
  );
});

test('changing the password demands the current one', async () => {
  const reg = registration('Clave', 10);
  const c = await service.register(reg);
  created.push(c.client.userId);

  await assert.rejects(
    () => service.updateProfile(c.client.userId, { password: 'nuevaclave' }),
    /la actual/,
    'sin la clave actual, una sesión robada bastaría para dejarte fuera de tu cuenta',
  );
  await assert.rejects(
    () => service.updateProfile(c.client.userId, { password: 'nuevaclave', currentPassword: 'mala' }),
    /no es correcta/,
  );

  await service.updateProfile(c.client.userId, {
    password: 'nuevaclave',
    currentPassword: reg.password,
  });
  const after = await service.login(reg.email, 'nuevaclave');
  assert.equal(after.client.userId, c.client.userId);
});

test('a suspended client cannot get in', async () => {
  const reg = registration('Susp', 11);
  const c = await service.register(reg);
  created.push(c.client.userId);

  await pool.query(`UPDATE clients SET status = 'suspended' WHERE user_id = $1`, [c.client.userId]);
  await assert.rejects(() => service.login(reg.email, reg.password), /suspendida/);
});
