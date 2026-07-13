import fp from 'fastify-plugin';

const TICK_MS = 60_000;

/**
 * Prepaid tariff lifecycle job (business decisions 2026-07-10):
 *  1. Advances active subscriptions into their next prepaid period (consumes
 *     advance payments automatically).
 *  2. Expires active subscriptions with no coverage left (grace is
 *     configurable via subscription_grace_hours; 0 = immediate suspension).
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
        const { rows: settingRows } = await app.db.query<{ value: number }>(
          `SELECT value FROM app_settings WHERE key = 'subscription_grace_hours'`,
        );
        const graceHours = Number(settingRows[0]?.value ?? 0);

        // 1) Advance into the next prepaid period
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
           RETURNING ds.id, ds.driver_id`,
        );

        // 2) Expire subscriptions with no coverage (past grace)
        const expired = await app.db.query<{ id: string; driver_id: string }>(
          `UPDATE driver_subscriptions ds SET status = 'expired'
           WHERE ds.status = 'active'
             AND ds.current_period_end + make_interval(hours => $1) <= now()
             AND NOT EXISTS (
               SELECT 1 FROM subscription_payments sp
               WHERE sp.driver_subscription_id = ds.id
                 AND sp.status = 'paid' AND sp.period_end > now()
             )
           RETURNING ds.id, ds.driver_id`,
          [graceHours],
        );

        for (const row of advanced.rows) {
          await app.db.query(
            `INSERT INTO audit_logs (event_type, entity, entity_id, data)
             VALUES ('subscription.period_advanced', 'driver_subscriptions', $1, $2)`,
            [row.id, JSON.stringify({ driverId: row.driver_id })],
          );
        }
        for (const row of expired.rows) {
          await app.db.query(
            `INSERT INTO audit_logs (event_type, entity, entity_id, data)
             VALUES ('subscription.expired', 'driver_subscriptions', $1, $2)`,
            [row.id, JSON.stringify({ driverId: row.driver_id })],
          );
          app.log.info({ driverId: row.driver_id }, 'subscription expired (auto)');
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
