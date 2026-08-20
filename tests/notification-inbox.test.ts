import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

/**
 * The inbox as the app consumes it, through the real endpoints and a real
 * driver token.
 *
 * Two properties matter more than the listing itself: a notice scheduled for
 * later is NOT in the inbox (it has not happened yet), and one driver can never
 * read or mark another's.
 */

let app: FastifyInstance;
let pool: pg.Pool;

before(async () => {
  app = await buildApp();
  await app.ready();
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
});
after(async () => {
  await pool.end();
  await app.close();
});

/** A throwaway driver plus a token signed the way the app's login signs one. */
async function newDriver(tag: string): Promise<{ id: string; token: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name)
     VALUES ('TEST', $1, $2) RETURNING id`,
    [tag, `TEST ${tag}`],
  );
  const id = rows[0]!.id;
  await pool.query(`INSERT INTO drivers (user_id, source, status) VALUES ($1, 'admin', 'approved')`, [id]);
  return { id, token: app.jwt.sign({ sub: id, type: 'driver' }) };
}

const removeDriver = (id: string): Promise<unknown> =>
  pool.query(`DELETE FROM users WHERE id = $1`, [id]);

async function seed(
  userId: string,
  type: string,
  title: string,
  deliverAfter = 'now()',
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO notifications (user_id, type, title, body, deliver_after)
     VALUES ($1, $2::notification_type, $3, 'cuerpo', ${deliverAfter}) RETURNING id::text`,
    [userId, type, title],
  );
  return rows[0]!.id;
}

interface InboxResponse {
  items: { id: string; type: string; title: string; readAt: string | null }[];
  nextCursor: string | null;
  unread: number;
}

const inbox = async (token: string, query = ''): Promise<InboxResponse> => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/driver-auth/me/notifications${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.payload);
  return res.json() as InboxResponse;
};

test('the inbox lists his notices, newest first, with the unread count', async () => {
  const driver = await newDriver('InboxList');
  try {
    await seed(driver.id, 'payment_received', 'Primero');
    await seed(driver.id, 'payment_approved', 'Segundo');

    const page = await inbox(driver.token);
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0]!.title, 'Segundo', 'lo más reciente arriba');
    assert.equal(page.unread, 2);
    assert.equal(page.nextCursor, null, 'no hay más páginas');
  } finally {
    await removeDriver(driver.id);
  }
});

test('a notice scheduled for later is NOT in the inbox', async () => {
  const driver = await newDriver('InboxDeferred');
  try {
    await seed(driver.id, 'charge_issued', 'Ya ocurrió');
    await seed(driver.id, 'charge_reminder', 'El domingo', `now() + interval '2 days'`);

    const page = await inbox(driver.token);
    assert.equal(page.items.length, 1, 'el recordatorio del domingo todavía no ha ocurrido');
    assert.equal(page.items[0]!.title, 'Ya ocurrió');
    assert.equal(page.unread, 1, 'y tampoco cuenta en la campana');
  } finally {
    await removeDriver(driver.id);
  }
});

test('marking one read lowers the badge, and doing it twice changes nothing', async () => {
  const driver = await newDriver('InboxRead');
  try {
    const id = await seed(driver.id, 'payment_rejected', 'Pago rechazado');
    const url = `/api/v1/driver-auth/me/notifications/${id}/read`;
    const headers = { authorization: `Bearer ${driver.token}` };

    const first = await app.inject({ method: 'POST', url, headers });
    assert.equal(first.statusCode, 204);
    const { rows: after } = await pool.query<{ readAt: Date }>(
      `SELECT read_at AS "readAt" FROM notifications WHERE id = $1::bigint`,
      [id],
    );
    const stamp = after[0]!.readAt;

    const second = await app.inject({ method: 'POST', url, headers });
    assert.equal(second.statusCode, 204, 'abrir dos veces el mismo aviso no es un error');
    const { rows: again } = await pool.query<{ readAt: Date }>(
      `SELECT read_at AS "readAt" FROM notifications WHERE id = $1::bigint`,
      [id],
    );
    assert.equal(
      again[0]!.readAt.getTime(),
      stamp.getTime(),
      'la segunda vez no mueve la marca: cuándo lo leyó es un hecho, no la última vez que lo abrió',
    );

    assert.equal((await inbox(driver.token)).unread, 0);
  } finally {
    await removeDriver(driver.id);
  }
});

test('read-all clears the badge but leaves the deferred one untouched', async () => {
  const driver = await newDriver('InboxReadAll');
  try {
    await seed(driver.id, 'charge_issued', 'Uno');
    await seed(driver.id, 'debt_overdue', 'Dos');
    await seed(driver.id, 'charge_reminder', 'Domingo', `now() + interval '2 days'`);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/driver-auth/me/notifications/read-all',
      headers: { authorization: `Bearer ${driver.token}` },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { marked: number }).marked, 2);

    const { rows } = await pool.query<{ readAt: Date | null }>(
      `SELECT read_at AS "readAt" FROM notifications
        WHERE user_id = $1 AND type = 'charge_reminder'`,
      [driver.id],
    );
    assert.equal(
      rows[0]!.readAt,
      null,
      'no se puede marcar como leído algo que aún no se le ha mostrado',
    );
  } finally {
    await removeDriver(driver.id);
  }
});

test('a driver never sees or touches another driver notices', async () => {
  const mine = await newDriver('InboxMine');
  const other = await newDriver('InboxOther');
  try {
    const foreignId = await seed(other.id, 'payment_approved', 'Ajeno');

    const page = await inbox(mine.token);
    assert.equal(page.items.length, 0, 'la bandeja se filtra por el token, no por un parámetro');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/driver-auth/me/notifications/${foreignId}/read`,
      headers: { authorization: `Bearer ${mine.token}` },
    });
    assert.equal(res.statusCode, 204, 'idempotente: no revela si el aviso existe');

    const { rows } = await pool.query<{ readAt: Date | null }>(
      `SELECT read_at AS "readAt" FROM notifications WHERE id = $1::bigint`,
      [foreignId],
    );
    assert.equal(rows[0]!.readAt, null, 'y sobre todo: no lo marcó');
  } finally {
    await removeDriver(mine.id);
    await removeDriver(other.id);
  }
});

test('paging walks backwards without repeating a notice', async () => {
  const driver = await newDriver('InboxPaging');
  try {
    for (let i = 1; i <= 5; i++) await seed(driver.id, 'charge_issued', `Aviso ${i}`);

    const first = await inbox(driver.token, '?limit=2');
    assert.deepEqual(
      first.items.map((i) => i.title),
      ['Aviso 5', 'Aviso 4'],
    );
    assert.ok(first.nextCursor);

    const second = await inbox(driver.token, `?limit=2&before=${first.nextCursor}`);
    assert.deepEqual(
      second.items.map((i) => i.title),
      ['Aviso 3', 'Aviso 2'],
      'sigue exactamente donde terminó la anterior',
    );

    const third = await inbox(driver.token, `?limit=2&before=${second.nextCursor}`);
    assert.deepEqual(third.items.map((i) => i.title), ['Aviso 1']);
    assert.equal(third.nextCursor, null);
  } finally {
    await removeDriver(driver.id);
  }
});

test('the badge travels inside /me/account, not in a call of its own', async () => {
  const driver = await newDriver('InboxBadge');
  try {
    await seed(driver.id, 'payment_rejected', 'Pago rechazado');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/driver-auth/me/account',
      headers: { authorization: `Bearer ${driver.token}` },
    });
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(
      (res.json() as { unreadNotifications: number }).unreadNotifications,
      1,
      'si el serializador se lo come, la campana nunca se enciende y nadie se entera',
    );
  } finally {
    await removeDriver(driver.id);
  }
});
