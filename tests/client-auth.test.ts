import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { ClientAuthRepository } from '../src/modules/client-auth/client-auth.repository.js';
import { ClientAuthService } from '../src/modules/client-auth/client-auth.service.js';

/**
 * The passenger side of the account. Since 2026-09-01 the roles are
 * INDEPENDENT (decision by Luis): the client owns his email, phone and
 * password on `clients`; the person (names, cédula, birth) is shared on
 * `users`. Registration is cédula-first: full form for a new person, short
 * form (attach) for an existing one proving it is him with his password.
 *
 * Every test builds its own throwaway people and deletes them afterwards: the
 * database is shared with production.
 */

let pool: pg.Pool;
let repo: ClientAuthRepository;
let service: ClientAuthService;

const created: string[] = [];

const stamp = Date.now();
const emailFor = (tag: string): string => `test.${tag}.${stamp}@edvroute.test`;
const phoneFor = (n: number): string => `+58412${String(stamp).slice(-5)}${String(n).padStart(2, '0')}`;
const cedulaFor = (n: number): string => `V-9${String(stamp).slice(-6)}${String(n).padStart(2, '0')}`;

before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const app = {
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
    await pool.query('DELETE FROM audit_logs WHERE actor_user_id = $1', [id]).catch((e) => {
      console.error('limpieza audit_logs falló:', id, e.message);
    });
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch((e) => {
      console.error('limpieza users falló:', id, e.message);
    });
  }
  await pool.end();
});

function registration(tag: string, n: number) {
  return {
    firstName: 'Prueba',
    lastName: tag,
    email: emailFor(tag),
    phone: phoneFor(n),
    birthDate: '1990-05-15',
    nationalId: cedulaFor(n),
    // Numeric 6-8 policy (Luis, 2026-09-01).
    password: '123456',
    acceptedPrivacy: true,
  };
}

/** A throwaway DRIVER-only person (his app password lives on `users`). */
async function driver(tag: string, n: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name, email, phone, password_hash)
     VALUES ('Prueba', $2, 'Prueba ' || $2, $1, $3, $4) RETURNING id`,
    [emailFor(tag), tag, phoneFor(n), await argon2.hash('claveChofer')],
  );
  const userId = rows[0]!.id;
  created.push(userId);
  await pool.query(
    `INSERT INTO drivers (user_id, source, status, national_id) VALUES ($1, 'app', 'approved', $2)`,
    [userId, cedulaFor(n)],
  );
  return userId;
}

test('registering creates the person and the role, each holding its own data', async () => {
  const result = await service.register(registration('Alta', 1));
  created.push(result.client.userId);

  assert.equal(result.client.status, 'active');
  assert.equal(result.client.fullName, 'Prueba Alta', 'el nombre completo se arma de sus partes');
  assert.equal(result.client.email, emailFor('Alta'), 'su correo de cliente');
  assert.ok(result.token, 'registrarse ya te deja dentro');

  // The contact lives on the ROLE; the person's users row carries none.
  const { rows } = await pool.query<{
    uEmail: string | null;
    cEmail: string | null;
    cHash: string | null;
  }>(
    `SELECT u.email AS "uEmail", c.email AS "cEmail", c.password_hash AS "cHash"
       FROM users u JOIN clients c ON c.user_id = u.id WHERE u.id = $1`,
    [result.client.userId],
  );
  assert.equal(rows[0]!.uEmail, null, 'la persona no carga el contacto del rol');
  assert.equal(rows[0]!.cEmail, emailFor('Alta'));
  assert.ok(rows[0]!.cHash, 'la clave del rol vive en clients');
});

test('he signs in with HIS email or HIS phone (the client ones)', async () => {
  const reg = registration('Entrar', 2);
  const c = await service.register(reg);
  created.push(c.client.userId);

  const byEmail = await service.login(reg.email, reg.password);
  assert.equal(byEmail.client.userId, c.client.userId);
  const byPhone = await service.login(reg.phone, reg.password);
  assert.equal(byPhone.client.userId, c.client.userId);
  const byUpper = await service.login(reg.email.toUpperCase(), reg.password);
  assert.equal(byUpper.client.userId, c.client.userId);
});

test('a wrong password and an unknown account say exactly the same thing', async () => {
  const reg = registration('Malo', 3);
  const c = await service.register(reg);
  created.push(c.client.userId);

  const wrong = await service.login(reg.email, '999999').catch((e: Error) => e.message);
  const unknown = await service.login('nadie.' + stamp + '@edvroute.test', '1').catch((e: Error) => e.message);
  assert.equal(wrong, unknown);
});

test('checkCedula picks the form: new · attachable · exists', async () => {
  assert.deepEqual(await service.checkCedula(cedulaFor(90)), { status: 'new' });

  await driver('Chequeo', 4);
  assert.deepEqual(await service.checkCedula(cedulaFor(4)), { status: 'attachable' });

  const c = await service.register(registration('Chequeado', 5));
  created.push(c.client.userId);
  assert.deepEqual(await service.checkCedula(cedulaFor(5)), { status: 'exists' });
});

test('the SHORT form: an affiliate gains the client hat with his OWN contact and password', async () => {
  const userId = await driver('Adjunto', 6);

  const result = await service.attach({
    nationalId: cedulaFor(6),
    currentPassword: 'claveChofer',
    email: emailFor('AdjuntoCliente'),
    phone: phoneFor(46),
    password: '654321',
    acceptedPrivacy: true,
  });
  assert.equal(result.client.userId, userId, 'la MISMA persona, segundo sombrero');
  assert.equal(result.client.email, emailFor('AdjuntoCliente'), 'correo PROPIO del rol cliente');
  assert.equal(result.client.nationalId, cedulaFor(6), 'la cédula verificada del chofer gana');

  // He logs in as a client with the NEW credentials…
  const login = await service.login(emailFor('AdjuntoCliente'), '654321');
  assert.equal(login.client.userId, userId);

  // …and his driver password did not move a hair (independent roles).
  const { rows } = await pool.query<{ hash: string }>(
    'SELECT password_hash AS hash FROM users WHERE id = $1',
    [userId],
  );
  assert.ok(await argon2.verify(rows[0]!.hash, 'claveChofer'), 'su clave de chofer intacta');
});

test('without the right password, the short form attaches nothing (one message for all refusals)', async () => {
  await driver('Cauto', 7);

  const bad = await service
    .attach({
      nationalId: cedulaFor(7),
      currentPassword: 'adivinada',
      email: emailFor('CautoCliente'),
      phone: phoneFor(47),
      password: '111111',
      acceptedPrivacy: true,
    })
    .catch((e: Error) => e.message);
  const unknownCedula = await service
    .attach({
      nationalId: cedulaFor(91),
      currentPassword: 'x',
      email: emailFor('NadieCliente'),
      phone: phoneFor(48),
      password: '111111',
      acceptedPrivacy: true,
    })
    .catch((e: Error) => e.message);
  assert.equal(bad, unknownCedula, 'clave errada y cédula desconocida responden igual');
});

test('the FULL form refuses a cédula somebody already holds', async () => {
  await driver('Dueño', 8);

  await assert.rejects(
    () => service.register({ ...registration('Imitador', 9), nationalId: cedulaFor(8) }),
    /ya tiene una cuenta/,
  );
});

test('editing his data: names touch the person, contact and password touch only this role', async () => {
  const reg = registration('Editar', 10);
  const c = await service.register(reg);
  const other = await service.register(registration('Otro', 11));
  created.push(c.client.userId, other.client.userId);

  const updated = await service.updateProfile(c.client.userId, {
    lastName: 'Apellido',
    address: 'Naguanagua',
  });
  assert.equal(updated.fullName, 'Prueba Apellido', 'el nombre completo se rehace solo');

  await assert.rejects(
    () => service.updateProfile(c.client.userId, { email: other.client.email! }),
    /ya pertenece a otra/,
    'el correo es único ENTRE clientes',
  );

  await assert.rejects(
    () => service.updateProfile(c.client.userId, { password: '222222' }),
    /la actual/,
  );
  await service.updateProfile(c.client.userId, {
    password: '222222',
    currentPassword: reg.password,
  });
  const after = await service.login(reg.email, '222222');
  assert.equal(after.client.userId, c.client.userId);
});

test('a suspended client cannot get in', async () => {
  const reg = registration('Susp', 12);
  const c = await service.register(reg);
  created.push(c.client.userId);

  await pool.query(`UPDATE clients SET status = 'suspended' WHERE user_id = $1`, [c.client.userId]);
  await assert.rejects(() => service.login(reg.email, reg.password), /suspendida/);
});
