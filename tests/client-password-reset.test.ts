import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { EmailMessage } from '../src/email/email-sender.js';
import { PasswordResetRepository } from '../src/modules/driver-auth/password-reset.repository.js';
import { PasswordResetService } from '../src/modules/driver-auth/password-reset.service.js';

/**
 * The passenger's "olvidé mi clave" (fase C-d, docs/proposals/cliente).
 *
 * The shared machinery (rate limits, attempt spending, token replay) is the
 * driver's, already exercised in production — what these tests pin down is the
 * CLIENT-specific part: identity by email alone, the `clients` scope of the
 * lookup, and the channel wording of the confirmation mail.
 *
 * Same discipline as client-auth.test.ts: throwaway people, deleted afterwards
 * (password_reset_codes cascades from users), because the database is shared
 * with production.
 */

let pool: pg.Pool;
let app: FastifyInstance;
let service: PasswordResetService;

const created: string[] = [];
const sent: EmailMessage[] = [];

const stamp = Date.now();
const emailFor = (tag: string): string => `test.reset.${tag}.${stamp}@edvroute.test`;

/** The 6 digits out of the captured email — the way the passenger reads them. */
function codeFrom(message: EmailMessage): string {
  const match = /Escribe este código en la app: (\d{6})/.exec(message.text ?? '');
  assert.ok(match, 'el correo debe llevar el código en su texto plano');
  return match![1]!;
}

before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  app = {
    db: pool,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    config: { NODE_ENV: 'test' },
    emailConfigured: true,
    email: {
      send: async (message: EmailMessage) => {
        sent.push(message);
      },
    },
    // Round-trip mock: sign/verify carry the payload as JSON, so the confirm
    // step can read back exactly what verify minted without a real secret.
    jwt: {
      sign: (payload: unknown) => JSON.stringify(payload),
      verify: (token: string) => JSON.parse(token),
    },
    httpErrors: {
      badRequest: (m: string) => Object.assign(new Error(m), { statusCode: 400 }),
      unauthorized: (m: string) => Object.assign(new Error(m), { statusCode: 401 }),
      notFound: (m: string) => Object.assign(new Error(m), { statusCode: 404 }),
      tooManyRequests: (m: string) => Object.assign(new Error(m), { statusCode: 429 }),
      serviceUnavailable: (m: string) => Object.assign(new Error(m), { statusCode: 503 }),
    },
  } as unknown as FastifyInstance;
  service = new PasswordResetService(app, new PasswordResetRepository(pool));
});

after(async () => {
  for (const id of created) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
  }
  await pool.end();
});

/** A throwaway person; `asClient` adds the client side, its absence leaves a driver-only user. */
async function person(tag: string, opts: { asClient?: boolean; asDriver?: boolean } = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name, email, password_hash)
     VALUES ('Prueba', $2, 'Prueba ' || $2, $1, $3) RETURNING id`,
    [emailFor(tag), tag, await argon2.hash('claveChofer')],
  );
  const userId = rows[0]!.id;
  created.push(userId);
  if (opts.asClient ?? true) {
    // Since 2026-09-01 the client's email and password live on `clients`.
    await pool.query(
      `INSERT INTO clients (user_id, status, accepted_privacy_at, email, password_hash)
       VALUES ($1, 'active', now(), $2, $3)`,
      [userId, emailFor(tag), await argon2.hash('claveoriginal')],
    );
  }
  if (opts.asDriver) {
    await pool.query(
      `INSERT INTO drivers (user_id, source, status, national_id) VALUES ($1, 'app', 'approved', $2)`,
      [userId, `V-9${String(stamp).slice(-7)}`],
    );
  }
  return userId;
}

test('a registered client gets his code by email, with just the email as identity', async () => {
  await person('Feliz');
  await service.requestClientCode({ email: emailFor('Feliz'), ip: null });

  const mail = sent.at(-1)!;
  assert.equal(mail.to, emailFor('Feliz'));
  assert.match(codeFrom(mail), /^\d{6}$/);
});

test('an unknown email and a DRIVER-only account are both refused', async () => {
  await assert.rejects(
    () => service.requestClientCode({ email: 'nadie.' + stamp + '@edvroute.test', ip: null }),
    /no coinciden/,
  );

  // A driver without the client side has his own channel; this door must not
  // confirm his email exists here.
  await person('SoloChofer', { asClient: false, asDriver: true });
  await assert.rejects(
    () => service.requestClientCode({ email: emailFor('SoloChofer'), ip: null }),
    /no coinciden/,
  );
});

test('the full walk: code → token → new password, and the mail speaks passenger', async () => {
  const userId = await person('Camino');
  await service.requestClientCode({ email: emailFor('Camino'), ip: null });
  const code = codeFrom(sent.at(-1)!);

  // A wrong code spends a try and says how many are left.
  await assert.rejects(
    () => service.verifyClientCode({ email: emailFor('Camino'), code: code === '000000' ? '000001' : '000000' }),
    /quedan 2 intentos/,
  );

  const { resetToken } = await service.verifyClientCode({ email: emailFor('Camino'), code });
  await service.confirm({ resetToken, password: '654321' }, 'client');

  // ONLY the client password changed (independent roles, 2026-09-01): the
  // driver one on `users` did not move a hair.
  const { rows } = await pool.query<{ cHash: string; uHash: string }>(
    `SELECT c.password_hash AS "cHash", u.password_hash AS "uHash"
       FROM users u JOIN clients c ON c.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  assert.ok(await argon2.verify(rows[0]!.cHash, '654321'), 'la clave de cliente es la nueva');
  assert.equal(await argon2.verify(rows[0]!.cHash, 'claveoriginal'), false);
  assert.ok(await argon2.verify(rows[0]!.uHash, 'claveChofer'), 'la de chofer sigue intacta');

  // The confirmation mail words "entrar" the passenger's way, not the cédula's.
  const changed = sent.at(-1)!;
  assert.match(changed.text ?? '', /con tu correo \(o tu teléfono\)/);
  assert.doesNotMatch(changed.text ?? '', /cédula/);

  // The token authorised ONE change: replaying it is refused.
  await assert.rejects(
    () => service.confirm({ resetToken, password: 'otramas' }, 'client'),
    /venció|ya se usó/,
  );
});
