import fp from 'fastify-plugin';
import { writeAudit } from '../modules/audit-logs/audit-writer.js';
import { EnrollmentRepository } from '../modules/drivers/enrollment.repository.js';

const TICK_MS = 60_000;
/** The alta tariff is weekly; approval anchors it to the current week's Monday. */
const WEEKLY_INTERVAL = '7 days';

/**
 * Automatic driver approval (v2, 2026-08-06). A registered driver whose alta
 * payment the admin already approved — membership `paid` + a weekly tariff +
 * **zero debt** — is approved automatically ON MONDAYS at 00:00, and his tariff
 * starts that same Monday (a full week). It never touches a driver who still owes
 * anything (e.g. paid the membership but not the tariff week): that one keeps
 * waiting until his debt reaches zero and the next Monday comes — so an admin's
 * delay in approving the payment never makes him re-pay a week (the tariff only
 * anchors when he is actually approved). The admin may still approve him earlier
 * by hand mid-week (keeping the days already elapsed); this job is the hands-off
 * path. Mirror of the penalized -> back "auto rejoin next Monday" rule.
 *
 * Only runs while the debt engine is on (the weekly Monday grid). Idempotent:
 * once a driver flips to `approved` he no longer matches. See the enum-as-text
 * note in subscription-scheduler.ts (status compared as text on purpose).
 */
export default fp(
  async (app) => {
    const enrollment = new EnrollmentRepository(app.db);
    let running = false;

    const tick = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        const { rows: settingRows } = await app.db.query<{ key: string; value: unknown }>(
          `SELECT key, value FROM app_settings
           WHERE key IN ('debt_engine_enabled', 'business_timezone')`,
        );
        const settings = Object.fromEntries(settingRows.map((r) => [r.key, r.value]));
        // Off = prepaid model, no Monday grid: automatic approval does not apply.
        if (settings['debt_engine_enabled'] !== true) return;
        const timezone = String(settings['business_timezone'] ?? 'America/Caracas');

        // Eligible = pending + alta payment approved (membership paid + a weekly
        // tariff) + ZERO debt, and today is Monday in the business timezone. The
        // debt check mirrors the driver-detail `debt` subquery: any owed membership
        // or any overdue / pending-with-invoice tariff week disqualifies him (a
        // payment still under review leaves its charges owed, so it is excluded too).
        const { rows } = await app.db.query<{ driverId: string }>(
          `SELECT d.user_id AS "driverId"
           FROM drivers d
           WHERE d.status::text = 'pending'
             AND extract(isodow FROM (now() AT TIME ZONE $1)) = 1
             AND EXISTS (SELECT 1 FROM membership_payments mp
                         WHERE mp.driver_id = d.user_id AND mp.status = 'paid')
             AND EXISTS (SELECT 1 FROM driver_subscriptions ds
                         JOIN subscription_plans p ON p.id = ds.plan_id
                         WHERE ds.driver_id = d.user_id AND p.billing_period = 'weekly')
             AND NOT EXISTS (SELECT 1 FROM membership_payments mp
                             WHERE mp.driver_id = d.user_id AND mp.status = 'pending')
             AND NOT EXISTS (SELECT 1 FROM subscription_payments sp
                             JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
                             WHERE ds.driver_id = d.user_id
                               AND (sp.status = 'overdue'
                                    OR (sp.status = 'pending' AND sp.invoice_id IS NOT NULL)))`,
          [timezone],
        );

        for (const { driverId } of rows) {
          try {
            // Same path as the manual approval; on a Monday the current-week anchor
            // is today, so the driver gets a full week starting now.
            await enrollment.approve(driverId, WEEKLY_INTERVAL, timezone, true);
            await writeAudit(app.db, {
              eventType: 'driver.approved',
              entity: 'drivers',
              entityId: driverId,
              data: { driverId, auto: true },
            });
            app.log.info({ driverId }, 'driver approved (auto, Monday)');
          } catch (err) {
            app.log.error({ err, driverId }, 'auto driver approval failed');
          }
        }
      } catch (err) {
        app.log.error(err, 'auto-approval scheduler tick failed');
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), TICK_MS);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));

    void tick(); // catch up on boot (covers a Monday the server was down for)
  },
  { name: 'auto-approval-scheduler', dependencies: ['db'] },
);
