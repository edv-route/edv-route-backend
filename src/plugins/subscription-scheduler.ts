import fp from 'fastify-plugin';
import { writeAudit } from '../modules/audit-logs/audit-writer.js';

const TICK_MS = 60_000;

/**
 * NOTE on enum comparisons: driver_status literals are compared as TEXT
 * (`d.status::text = '…'`). Supabase serves us through a connection pooler, and
 * a pooled backend opened before an `ALTER TYPE … ADD VALUE` keeps a stale
 * catalog cache: parsing the new literal then fails with
 * "invalid input value for enum driver_status" (routine enum_in) until that
 * connection recycles. Casting the column to text never invokes enum_in, so
 * these jobs cannot break after a future enum migration.
 *
 * Prepaid tariff lifecycle job (business decisions 2026-07-10):
 *  1. Advances active subscriptions into their next prepaid period (consumes
 *     advance payments automatically).
 *  2. Expires active subscriptions with no coverage left (grace is
 *     configurable via subscription_grace_hours; 0 = immediate suspension).
 *  3. Activates a scheduled plan change once its first paid period starts
 *     (decision 2026-07-15). Runs after (2) so the outgoing subscription is
 *     already expired: only one can be active per driver.
 * The driver's operational state derives from the subscription: expired =
 * cannot take rides; a renewal payment reactivates it instantly (no admin
 * status involved). Every automatic transition is audited (system actor).
 * Idempotent and cheap: runs every minute and on boot.
 */
export default fp(
  async (app) => {
    let running = false;

    const tick = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        const { rows: settingRows } = await app.db.query<{ key: string; value: unknown }>(
          `SELECT key, value FROM app_settings
           WHERE key IN ('subscription_grace_hours', 'debt_engine_enabled')`,
        );
        const settings = Object.fromEntries(settingRows.map((r) => [r.key, r.value]));
        const graceHours = Number(settings['subscription_grace_hours'] ?? 0);
        // When the debt engine (v8) is on, WEEKLY plans are governed by it
        // (arrears up to a cap instead of immediate expiry), so this job must
        // not expire them. Off = every plan keeps the prepaid behaviour.
        const debtEngine = settings['debt_engine_enabled'] === true;

        // 1) Advance into the next prepaid period (paused drivers are frozen:
        // their tariff clock is shifted forward on resume, not consumed here)
        const advanced = await app.db.query<{ id: string; driver_id: string }>(
          `UPDATE driver_subscriptions ds SET
             current_period_start = sp.period_start,
             current_period_end = sp.period_end
           FROM subscription_payments sp
           WHERE ds.status = 'active'
             AND ds.current_period_end <= now()
             AND sp.driver_subscription_id = ds.id
             AND sp.status = 'paid'
             AND sp.period_start <= now() AND sp.period_end > now()
             AND NOT EXISTS (
               SELECT 1 FROM drivers d
               WHERE d.user_id = ds.driver_id AND d.status::text = 'paused'
             )
           RETURNING ds.id, ds.driver_id`,
        );

        // 2) Expire subscriptions with no coverage (past grace). Paused drivers
        // are skipped: their tariff is frozen until the admin lifts the pause.
        const expired = await app.db.query<{ id: string; driver_id: string }>(
          `UPDATE driver_subscriptions ds SET status = 'expired'
           WHERE ds.status = 'active'
             AND ds.current_period_end + make_interval(hours => $1) <= now()
             AND NOT EXISTS (
               SELECT 1 FROM subscription_payments sp
               WHERE sp.driver_subscription_id = ds.id
                 AND sp.status = 'paid' AND sp.period_end > now()
             )
             AND NOT EXISTS (
               SELECT 1 FROM drivers d
               WHERE d.user_id = ds.driver_id AND d.status::text = 'paused'
             )
             AND NOT ($2::boolean AND EXISTS (
               SELECT 1 FROM subscription_plans p
               WHERE p.id = ds.plan_id AND p.billing_period = 'weekly'
             ))
           RETURNING ds.id, ds.driver_id`,
          [graceHours, debtEngine],
        );

        // 3) Start a scheduled plan change whose paid coverage began.
        // Pending drivers also have scheduled subscriptions (wizard step 4):
        // those must only start at approval, hence the approved filter.
        // solicitudes-app: an approved driver whose tariff START hasn't been set
        // yet (tariff_start_set_at null) also has a scheduled subscription — it
        // must NOT auto-start here; it waits for `startTariff`, which anchors it.
        const started = await app.db.query<{ id: string; driver_id: string; plan_id: number }>(
          `UPDATE driver_subscriptions ds SET
             status = 'active',
             started_at = COALESCE(ds.started_at, now()),
             current_period_start = sp.period_start,
             current_period_end = sp.period_end
           FROM subscription_payments sp, drivers d
           WHERE ds.status = 'scheduled'
             AND d.user_id = ds.driver_id AND d.status::text = 'approved'
             AND d.tariff_start_set_at IS NOT NULL
             AND sp.driver_subscription_id = ds.id AND sp.status = 'paid'
             AND sp.period_start <= now() AND sp.period_end > now()
             AND NOT EXISTS (
               SELECT 1 FROM driver_subscriptions other
               WHERE other.driver_id = ds.driver_id AND other.status = 'active'
             )
           RETURNING ds.id, ds.driver_id, ds.plan_id`,
        );

        for (const row of advanced.rows) {
          await writeAudit(app.db, {
            eventType: 'subscription.period_advanced',
            entity: 'driver_subscriptions',
            entityId: row.id,
            data: { driverId: row.driver_id },
          });
        }
        for (const row of expired.rows) {
          await writeAudit(app.db, {
            eventType: 'subscription.expired',
            entity: 'driver_subscriptions',
            entityId: row.id,
            data: { driverId: row.driver_id },
          });
          app.log.info({ driverId: row.driver_id }, 'subscription expired (auto)');
        }
        for (const row of started.rows) {
          await writeAudit(app.db, {
            eventType: 'subscription.plan_started',
            entity: 'driver_subscriptions',
            entityId: row.id,
            data: { driverId: row.driver_id, planId: row.plan_id },
          });
          app.log.info({ driverId: row.driver_id, planId: row.plan_id }, 'scheduled plan started (auto)');
        }
      } catch (err) {
        app.log.error(err, 'subscription scheduler tick failed');
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), TICK_MS);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));

    void tick(); // catch up on boot (covers server downtime)
  },
  { name: 'subscription-scheduler', dependencies: ['db'] },
);
