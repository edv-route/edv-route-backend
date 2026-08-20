import fp from 'fastify-plugin';
import type pg from 'pg';
import type NotificationType from '../db/models/public/NotificationType.js';
import { LogPushSender, type PushSender } from '../notifications/push-sender.js';

const TICK_MS = 60_000;
/**
 * Rows claimed per pass. Small on purpose: the batch is sent inside ONE
 * transaction (see below), and a transaction's length is the time its row locks
 * are held. 25 pushes is a couple of seconds even on a bad day.
 */
const BATCH_SIZE = 25;
/** After this many failed passes the row is given up as `failed`, not retried forever. */
const MAX_ATTEMPTS = 3;

interface PendingRow {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  attempts: number;
}

export interface DispatchTickResult {
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * WHETHER to dispatch is the plugin's business (below); this function only
 * dispatches. Keeping the master switch out of here is what lets the suite
 * exercise delivery without ever flipping a global `app_settings` row - the row
 * the DEPLOYED backend reads, since prod and dev share one database. A test
 * that has to turn on the real switch to prove anything is a test that can push
 * to real drivers when an assertion dies before the restore.
 *
 * One pass of the outbox dispatcher. Exported so tests can drive it directly
 * instead of waiting for the timer (same shape as `runDebtEngineTick`).
 *
 * The whole batch runs inside a single transaction, and that is the design, not
 * laziness. `FOR UPDATE SKIP LOCKED` makes the claim exclusive without inventing
 * a `sending` state - and a `sending` state is precisely what would leave rows
 * stranded forever the first time the process dies mid-send. Here a crash rolls
 * back to `pending` and the next pass picks them up: at-least-once delivery,
 * which for a notice is the right side to err on.
 */
export async function runNotificationDispatchTick(
  pool: pg.Pool,
  sender: PushSender,
): Promise<DispatchTickResult> {
  const client = await pool.connect();
  const result: DispatchTickResult = { sent: 0, skipped: 0, failed: 0 };
  try {
    await client.query('BEGIN');

    const { rows: pending } = await client.query<PendingRow>(
      `SELECT id, user_id AS "userId", type, title, body, push_attempts AS attempts
         FROM notifications
        WHERE push_status = 'pending'
          AND deliver_after <= now()
        ORDER BY deliver_after
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [BATCH_SIZE],
    );

    for (const row of pending) {
      const { rows: tokens } = await client.query<{ token: string }>(
        `SELECT token FROM device_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
        [row.userId],
      );

      // No live device: not a failure. The inbox already has the notice, and for
      // the drivers whose phone can never receive push (Huawei without Play
      // Services, permission denied on Android 13+) that is the only channel.
      if (tokens.length === 0) {
        await client.query(
          `UPDATE notifications SET push_status = 'skipped', push_sent_at = now() WHERE id = $1`,
          [row.id],
        );
        result.skipped += 1;
        continue;
      }

      try {
        const sent = await sender.send({
          tokens: tokens.map((t) => t.token),
          title: row.title,
          body: row.body,
          data: { notificationId: String(row.id), type: row.type },
        });

        if (sent.invalidTokens.length > 0) {
          await client.query(
            `UPDATE device_tokens SET revoked_at = now() WHERE token = ANY($1::text[])`,
            [sent.invalidTokens],
          );
        }

        // Every token was dead: nothing reached anyone, and the rows are now
        // revoked. Marking it `sent` would claim a delivery that did not happen.
        const status = sent.delivered > 0 ? 'sent' : 'skipped';
        await client.query(
          `UPDATE notifications
              SET push_status = $2, push_sent_at = now(), push_error = NULL
            WHERE id = $1`,
          [row.id, status],
        );
        if (status === 'sent') result.sent += 1;
        else result.skipped += 1;
      } catch (err) {
        // One recipient's failure must not abort the batch: the other rows are
        // already claimed in this transaction and would be rolled back with it.
        const attempts = row.attempts + 1;
        await client.query(
          // Every parameter is cast: reusing $2 as both a column value and a
          // comparison operand makes Postgres deduce two types for it and the
          // statement dies with 42P08 ("text versus integer").
          `UPDATE notifications
              SET push_attempts = $2::int,
                  push_status = CASE WHEN $2::int >= $3::int THEN 'failed'::notification_push_status
                                     ELSE 'pending'::notification_push_status END,
                  push_error = $4::text
            WHERE id = $1`,
          [row.id, attempts, MAX_ATTEMPTS, err instanceof Error ? err.message : String(err)],
        );
        if (attempts >= MAX_ATTEMPTS) result.failed += 1;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return result;
}

/**
 * Outbox dispatcher: the only place that turns a stored notice into a push.
 *
 * TWO independent locks stand between a developer's laptop and a real driver's
 * phone, because prod and dev share ONE database:
 *
 *  1. This plugin schedules NOTHING outside NODE_ENV=production. Not a flag, not
 *     a setting - a local backend simply has no dispatcher. Without it, testing
 *     a rejected payment on a laptop pushes the amount to a real driver, and two
 *     backends running at once push it twice.
 *  2. `app_settings.notifications_enabled` (off by default), the business kill
 *     switch, read on every tick like `debt_engine_enabled`.
 */
export default fp(
  async (app) => {
    if (app.config.NODE_ENV !== 'production') {
      app.log.info(
        'notification dispatcher NOT started (requires NODE_ENV=production; prod and dev share the database)',
      );
      return;
    }

    const sender: PushSender = new LogPushSender((payload, msg) => app.log.info(payload, msg));
    let running = false;

    const tick = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        // Read on every tick, like `debt_engine_enabled`: flipping it must take
        // effect without a redeploy, in both directions.
        const { rows } = await app.db.query<{ value: unknown }>(
          `SELECT value FROM app_settings WHERE key = 'notifications_enabled'`,
        );
        if (rows[0]?.value !== true) return;

        const outcome = await runNotificationDispatchTick(app.db, sender);
        if (outcome.sent + outcome.skipped + outcome.failed > 0) {
          app.log.info(outcome, 'notification dispatch tick');
        }
      } catch (err) {
        app.log.error(err, 'notification dispatcher tick failed');
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), TICK_MS);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));

    void tick(); // catch up on boot (covers server downtime)
  },
  { name: 'notification-dispatcher', dependencies: ['db'] },
);
