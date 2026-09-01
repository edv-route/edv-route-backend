import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { ClientsRepository } from '../src/modules/clients/clients.repository.js';
import { ClientsService } from '../src/modules/clients/clients.service.js';

/**
 * The panel's clients list (sección «Clientes», 2026-08-31). Same discipline
 * as the other client tests: throwaway people, deleted afterwards, because the
 * database is shared with production.
 */

let pool: pg.Pool;
let service: ClientsService;

const created: string[] = [];
const stamp = Date.now();
const emailFor = (tag: string): string => `test.panel.${tag}.${stamp}@edvroute.test`;

before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const app = {
    db: pool,
    storage: undefined, // no bucket in tests: photoUrl degrades to null
    log: { info: () => {}, warn: () => {}, error: () => {} },
    httpErrors: {
      notFound: (m: string) => Object.assign(new Error(m), { statusCode: 404 }),
    },
  } as unknown as FastifyInstance;
  service = new ClientsService(app, new ClientsRepository(pool));
});

after(async () => {
  for (const id of created) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
  }
  await pool.end();
});

async function person(tag: string, opts: { asDriver?: boolean; suspended?: boolean } = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name)
     VALUES ('Panel', $1, 'Panel ' || $1) RETURNING id`,
    [tag],
  );
  const userId = rows[0]!.id;
  created.push(userId);
  // Since 2026-09-01 the list reads the ROLE's own contact, on `clients`.
  await pool.query(
    `INSERT INTO clients (user_id, status, accepted_privacy_at, email, phone)
     VALUES ($1, $2, now(), $3, $4)`,
    [
      userId,
      opts.suspended ? 'suspended' : 'active',
      emailFor(tag),
      // 0424 prefix: 0412 belongs to client-auth.test.ts, and the two files
      // can load on the SAME millisecond — clients.phone is unique now.
      `+58424${String(stamp).slice(-5)}${String(created.length).padStart(2, '0')}`,
    ],
  );
  if (opts.asDriver) {
    await pool.query(
      `INSERT INTO drivers (user_id, source, status, national_id) VALUES ($1, 'app', 'approved', $2)`,
      [userId, `V-8${String(stamp).slice(-7)}`],
    );
  }
  return userId;
}

test('the list finds a client by name, email or phone — and only clients', async () => {
  const id = await person('Buscable');

  const byName = await service.list({ search: `Panel Buscable`, page: 1, limit: 10 });
  assert.ok(byName.items.some((i) => i.userId === id), 'por nombre');

  const byEmail = await service.list({ search: emailFor('Buscable'), page: 1, limit: 10 });
  assert.equal(byEmail.total, 1, 'por correo: exactamente él');
  assert.equal(byEmail.items[0]!.photoUrl, null, 'sin bucket, la foto degrada a null');
});

test('a client who is ALSO an affiliate carries his cédula; a pure client does not', async () => {
  await person('Doble', { asDriver: true });
  await person('Puro');

  const both = await service.list({ search: `test.panel.`, page: 1, limit: 50 });
  const doble = both.items.find((i) => i.email === emailFor('Doble'));
  const puro = both.items.find((i) => i.email === emailFor('Puro'));
  assert.ok(doble?.nationalId, 'el afiliado-cliente muestra su cédula');
  assert.equal(puro?.nationalId, null, 'el cliente puro no tiene');
});

test('the status filter separates suspended clients', async () => {
  const id = await person('Suspendido', { suspended: true });

  const suspended = await service.list({ status: 'suspended', search: emailFor('Suspendido'), page: 1, limit: 10 });
  assert.ok(suspended.items.some((i) => i.userId === id));

  const active = await service.list({ status: 'active', search: emailFor('Suspendido'), page: 1, limit: 10 });
  assert.equal(active.total, 0, 'no aparece entre los activos');
});

test('the detail card carries the person extras the list does not', async () => {
  const id = await person('Ficha');
  await pool.query(
    `UPDATE users SET address = 'Naguanagua, Carabobo', birth_date = '1990-05-15' WHERE id = $1`,
    [id],
  );

  const detail = await service.getDetail(id);
  assert.equal(detail.address, 'Naguanagua, Carabobo');
  assert.ok(detail.acceptedPrivacyAt, 'la fecha del consentimiento viaja a la ficha');
  assert.equal(detail.isAffiliate, false);

  await assert.rejects(
    () => service.getDetail('00000000-0000-0000-0000-000000000000'),
    /no encontrado/,
  );
});
