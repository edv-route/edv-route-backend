import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { writeNotification, writeNotifications } from '../src/modules/notifications/notification-writer.js';
import { runNotificationDispatchTick } from '../src/plugins/notification-dispatcher.js';
import type { PushMessage, PushResult, PushSender } from '../src/notifications/push-sender.js';

/**
 * The transactional outbox: a notice is written with the fact it announces, and
 * a separate pass delivers it. What is asserted here is exactly the two halves
 * of that promise — that a rolled-back fact leaves NO notice, and that the
 * dispatcher never claims a delivery it did not make.
 *
 * These never touch `app_settings.notifications_enabled`. The switch belongs to
 * the plugin, not to the dispatch function, precisely so this suite cannot leave
 * the DEPLOYED backend pushing (one database serves prod and dev).
 */

let pool: pg.Pool;

/** Records what it was asked to send; optionally fails or reports dead tokens. */
class FakeSender implements PushSender {
  readonly sent: PushMessage[] = [];
  constructor(
    private readonly outcome: (m: PushMessage) => PushResult = (m) => ({
      delivered: m.tokens.length,
      invalidTokens: [],
    }),
  ) {}
  async send(message: PushMessage): Promise<PushResult> {
    this.sent.push(message);
    return this.outcome(message);
  }
}

before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
});
after(async () => {
  await pool.end();
});

async function makeUser(tag: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name)
     VALUES ('TEST', $1, $2) RETURNING id`,
    [tag, `TEST ${tag}`],
  );
  return rows[0]!.id;
}

/** Notifications and device tokens hang off the user with ON DELETE CASCADE. */
async function removeUser(userId: string): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

async function readNotices(userId: string) {
  const { rows } = await pool.query<{
    id: string;
    type: string;
    pushStatus: string;
    attempts: number;
    error: string | null;
  }>(
    `SELECT id, type, push_status AS "pushStatus", push_attempts AS attempts, push_error AS error
       FROM notifications WHERE user_id = $1 ORDER BY id`,
    [userId],
  );
  return rows;
}

test('a notice written inside a transaction that rolls back leaves NOTHING', async () => {
  const userId = await makeUser('OutboxRollback');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await writeNotification(client, {
      userId,
      type: 'payment_approved',
      title: 'Pago aprobado',
      body: 'Se aprobó tu pago de $70',
    });
    await client.query('ROLLBACK');

    assert.equal(
      (await readNotices(userId)).length,
      0,
      'el aviso debe morir con la transacción del hecho: si el pago se revierte, no hubo pago que avisar',
    );
  } finally {
    client.release();
    await removeUser(userId);
  }
});

test('the notice survives exactly as long as the fact commits', async () => {
  const userId = await makeUser('OutboxCommit');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await writeNotification(client, {
      userId,
      type: 'payment_rejected',
      title: 'Pago rechazado',
      body: 'Revisa el motivo',
      payload: { reason: 'El comprobante no es legible' },
    });
    await client.query('COMMIT');

    const notices = await readNotices(userId);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.type, 'payment_rejected');
    assert.equal(notices[0]!.pushStatus, 'pending', 'nace pendiente de envío');

    const { rows } = await pool.query<{ payload: { reason: string } }>(
      `SELECT payload FROM notifications WHERE user_id = $1`,
      [userId],
    );
    assert.equal(
      rows[0]!.payload.reason,
      'El comprobante no es legible',
      'el motivo del rechazo viaja en el payload: es lo que hacía falta el día que el chofer no se enteró',
    );
  } finally {
    client.release();
    await removeUser(userId);
  }
});

test('a driver with no device is SKIPPED, never failed (la bandeja es su único canal)', async () => {
  const userId = await makeUser('OutboxNoDevice');
  try {
    await writeNotification(pool, {
      userId,
      type: 'charge_issued',
      title: 'Nuevo cobro',
      body: 'Se emitió tu semana',
    });
    const sender = new FakeSender();
    await runNotificationDispatchTick(pool, sender);

    const notices = await readNotices(userId);
    assert.equal(notices[0]!.pushStatus, 'skipped');
    assert.equal(sender.sent.length, 0, 'sin teléfono registrado no se llama al proveedor');
  } finally {
    await removeUser(userId);
  }
});

test('with a live device the notice is sent, and carries its id and type', async () => {
  const userId = await makeUser('OutboxSend');
  try {
    await pool.query(
      `INSERT INTO device_tokens (user_id, token, platform) VALUES ($1, $2, 'android')`,
      [userId, `test-token-send-${userId}`],
    );
    await writeNotification(pool, {
      userId,
      type: 'debt_overdue',
      title: 'Cuenta en mora',
      body: 'Tu semana comenzó sin pagar',
    });

    const sender = new FakeSender();
    await runNotificationDispatchTick(pool, sender);

    const notices = await readNotices(userId);
    assert.equal(notices[0]!.pushStatus, 'sent');
    const message = sender.sent.find((m) => m.title === 'Cuenta en mora');
    assert.ok(message, 'el despachador debió enviar este aviso');
    assert.equal(message.data?.type, 'debt_overdue');
    assert.equal(message.data?.notificationId, notices[0]!.id);
  } finally {
    await removeUser(userId);
  }
});

test('a notice held for later is NOT dispatched yet (la mora se marca a las 00:05, el aviso sale a las 7)', async () => {
  const userId = await makeUser('OutboxDeferred');
  try {
    await pool.query(
      `INSERT INTO device_tokens (user_id, token, platform) VALUES ($1, $2, 'android')`,
      [userId, `test-token-deferred-${userId}`],
    );
    await writeNotification(pool, {
      userId,
      type: 'debt_overdue',
      title: 'Cuenta en mora',
      body: 'Tu semana comenzó sin pagar',
      deliverAfter: new Date(Date.now() + 60 * 60 * 1000),
    });

    await runNotificationDispatchTick(pool, new FakeSender());

    assert.equal(
      (await readNotices(userId))[0]!.pushStatus,
      'pending',
      'no puede salir antes de su hora',
    );
  } finally {
    await removeUser(userId);
  }
});

test('a send that fails is retried, and only given up after the third attempt', async () => {
  const userId = await makeUser('OutboxRetry');
  try {
    await pool.query(
      `INSERT INTO device_tokens (user_id, token, platform) VALUES ($1, $2, 'android')`,
      [userId, `test-token-retry-${userId}`],
    );
    await writeNotification(pool, {
      userId,
      type: 'penalty_applied',
      title: 'Penalización',
      body: 'Superaste el tope de deuda',
    });

    const broken: PushSender = {
      async send() {
        throw new Error('proveedor caído');
      },
    };

    await runNotificationDispatchTick(pool, broken);
    let notice = (await readNotices(userId))[0]!;
    assert.equal(notice.pushStatus, 'pending', 'el primer fallo NO puede perder el aviso');
    assert.equal(notice.attempts, 1);
    assert.equal(notice.error, 'proveedor caído', 'el motivo del fallo queda escrito');

    await runNotificationDispatchTick(pool, broken);
    await runNotificationDispatchTick(pool, broken);
    notice = (await readNotices(userId))[0]!;
    assert.equal(notice.attempts, 3);
    assert.equal(notice.pushStatus, 'failed', 'a la tercera se abandona, no se reintenta para siempre');
  } finally {
    await removeUser(userId);
  }
});

test('a dead token is revoked, and its notice is NOT reported as delivered', async () => {
  const userId = await makeUser('OutboxDeadToken');
  const token = `test-token-dead-${userId}`;
  try {
    await pool.query(
      `INSERT INTO device_tokens (user_id, token, platform) VALUES ($1, $2, 'android')`,
      [userId, token],
    );
    await writeNotification(pool, {
      userId,
      type: 'application_approved',
      title: 'Solicitud aprobada',
      body: 'Ya puedes trabajar',
    });

    await runNotificationDispatchTick(
      pool,
      new FakeSender((m) => ({ delivered: 0, invalidTokens: m.tokens })),
    );

    const { rows } = await pool.query<{ revokedAt: Date | null }>(
      `SELECT revoked_at AS "revokedAt" FROM device_tokens WHERE token = $1`,
      [token],
    );
    assert.ok(rows[0]!.revokedAt, 'un token que el proveedor da por muerto se revoca, o la tabla se llena de basura');
    assert.equal(
      (await readNotices(userId))[0]!.pushStatus,
      'skipped',
      'nadie lo recibió: marcarlo "sent" sería mentir sobre una entrega',
    );
  } finally {
    await removeUser(userId);
  }
});

test('the same phone cannot belong to two drivers at once', async () => {
  const first = await makeUser('OutboxPhoneA');
  const second = await makeUser('OutboxPhoneB');
  const token = `test-token-shared-${first}`;
  try {
    await pool.query(
      `INSERT INTO device_tokens (user_id, token, platform) VALUES ($1, $2, 'android')`,
      [first, token],
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO device_tokens (user_id, token, platform) VALUES ($1, $2, 'android')`,
          [second, token],
        ),
      /device_tokens_token_key|unique/i,
      'el token identifica un TELÉFONO: dos dueños significa que el siguiente que use el aparato recibe los montos del anterior',
    );
  } finally {
    await removeUser(first);
    await removeUser(second);
  }
});

test('the engine writes one notice per affected driver in a single statement', async () => {
  const first = await makeUser('OutboxBulkA');
  const second = await makeUser('OutboxBulkB');
  try {
    await writeNotifications(pool, [
      { userId: first, type: 'charge_issued', title: 'Nuevo cobro', body: 'Semana emitida' },
      {
        userId: second,
        type: 'charge_reminder',
        title: 'Recordatorio',
        body: 'Tu semana empieza el lunes',
        deliverAfter: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    ]);

    assert.equal((await readNotices(first))[0]!.type, 'charge_issued');
    assert.equal((await readNotices(second))[0]!.type, 'charge_reminder');
  } finally {
    await removeUser(first);
    await removeUser(second);
  }
});
