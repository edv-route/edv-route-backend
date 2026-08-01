import fp from 'fastify-plugin';
import type pg from 'pg';
import { writeAudit } from '../modules/audit-logs/audit-writer.js';

const TICK_MS = 60_000;

interface EngineConfig {
  enabled: boolean;
  timezone: string;
  debtCapWeeks: number;
  /** ISO day of week the weekly charge is issued (1 = Monday … 7 = Sunday). */
  billingDayOfWeek: number;
  /** Hour of day (0-23, business timezone) the charge is issued. */
  billingHour: number;
  /** Weeks of fine charged once the debt cap is crossed. */
  penaltyWeeks: number;
  /** 'auto' = rejoin next Monday after settling; the admin may still reactivate now. */
  reactivationMode: string;
}

export interface DebtTickResult {
  enabled: boolean;
  issued: number;
  markedOverdue: number;
  penaltiesIssued: number;
  scheduledReactivations: number;
  moved: { driverId: string; status: string; weeks: number }[];
}

async function loadConfig(db: pg.Pool): Promise<EngineConfig> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM app_settings WHERE key IN
       ('debt_engine_enabled', 'business_timezone', 'debt_cap_weeks',
        'billing_day_of_week', 'billing_hour', 'penalty_weeks', 'reactivation_mode')`,
  );
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    enabled: map['debt_engine_enabled'] === true,
    timezone: String(map['business_timezone'] ?? 'America/Caracas'),
    debtCapWeeks: Number(map['debt_cap_weeks'] ?? 2),
    billingDayOfWeek: Number(map['billing_day_of_week'] ?? 5),
    billingHour: Number(map['billing_hour'] ?? 18),
    penaltyWeeks: Number(map['penalty_weeks'] ?? 1),
    reactivationMode: String(map['reactivation_mode'] ?? 'auto'),
  };
}

/**
 * One pass of the debt & penalty engine (design v8, Fase B). Exported so it can
 * be driven directly by tests instead of waiting for the timer.
 *
 * Master switch: `debt_engine_enabled`. While false this returns immediately
 * and the prepaid model keeps running untouched. Scope: **weekly plans only**.
 *
 *  1. Issues next week's charge (`pending`, week starting next Monday) once the
 *     billing moment has passed. NO invoice here: an invoice is a receipt of
 *     money received, so it is emitted when the charge is actually paid.
 *  2. Marks arrears: `pending` charges whose week already started -> `overdue`.
 *  3. Deferred reactivation (auto mode): a penalized driver who cleared the debt
 *     rejoins next Monday, not instantly (the admin can override immediately).
 *  4. Derives the driver's state from the debt (never written by hand):
 *     0 weeks -> approved · 1..cap -> overdue (still operates) · >cap ->
 *     penalized. A driver who settled but still has a pending reactivation
 *     moment stays penalized until it arrives.
 *  5. Issues the penalty fine to penalized drivers (once, while unpaid). The
 *     fine counts as debt, so it must be paid to rejoin.
 *
 * Penalized drivers receive no weekly charges, which freezes the debt at the
 * cap. Advances suppress the charge (the idempotency guard finds the row).
 */
export async function runDebtEngineTick(db: pg.Pool): Promise<DebtTickResult> {
  const cfg = await loadConfig(db);
  if (!cfg.enabled) {
    return {
      enabled: false, issued: 0, markedOverdue: 0,
      penaltiesIssued: 0, scheduledReactivations: 0, moved: [],
    };
  }

  // 1) Issue next week's charge. date_trunc('week') anchors on Monday, which
  // matches week_anchor_day = 1.
  const issued = await db.query<{ id: string; driverId: string }>(
    `WITH moment AS (
       SELECT date_trunc('week', (now() AT TIME ZONE $1)) AS week_start,
              date_trunc('week', (now() AT TIME ZONE $1))
                + make_interval(days => $2 - 1, hours => $3) AS emit_at,
              date_trunc('week', (now() AT TIME ZONE $1)) + interval '7 days' AS next_start
     ), ins AS (
       INSERT INTO subscription_payments
         (driver_subscription_id, period_start, period_end, amount_usd, status)
       SELECT ds.id,
              (m.next_start AT TIME ZONE $1),
              ((m.next_start + interval '7 days') AT TIME ZONE $1),
              p.price_usd,
              'pending'
       FROM driver_subscriptions ds
       JOIN subscription_plans p ON p.id = ds.plan_id
       JOIN drivers d ON d.user_id = ds.driver_id
       CROSS JOIN moment m
       WHERE ds.status = 'active'
         AND p.billing_period = 'weekly'
         AND d.status::text IN ('approved', 'overdue')
         AND (now() AT TIME ZONE $1) >= m.emit_at
         AND NOT EXISTS (
           SELECT 1 FROM subscription_payments x
           WHERE x.driver_subscription_id = ds.id
             AND x.period_start = (m.next_start AT TIME ZONE $1)
             AND x.charge_kind = 'period'
             AND x.status <> 'refunded'
         )
         -- Never bill a week already covered by paid coverage. The engine must
         -- reason about coverage (paidUntil), NOT exact Monday alignment: an
         -- advance anchored to any weekday (approved while the engine was off) is
         -- honoured, so no phantom charge is emitted. Root-cause fix 2026-07-29.
         AND (m.next_start AT TIME ZONE $1) >= COALESCE(
           (SELECT max(cov.period_end) FROM subscription_payments cov
            WHERE cov.driver_subscription_id = ds.id
              AND cov.status = 'paid' AND cov.charge_kind = 'period'),
           (m.next_start AT TIME ZONE $1))
       RETURNING id, driver_subscription_id
     )
     SELECT i.id, ds.driver_id AS "driverId"
     FROM ins i JOIN driver_subscriptions ds ON ds.id = i.driver_subscription_id`,
    [cfg.timezone, cfg.billingDayOfWeek, cfg.billingHour],
  );

  // 2) Charges whose week already started and were not paid = debt. Only for
  // operating drivers (approved/overdue): a `pending` driver's alta-debt week
  // must NOT be flipped to overdue by the engine — it settles at approval.
  const overdue = await db.query<{ id: string; driverId: string }>(
    `UPDATE subscription_payments sp SET status = 'overdue'
     FROM driver_subscriptions ds
     JOIN drivers d ON d.user_id = ds.driver_id
     WHERE sp.driver_subscription_id = ds.id
       AND d.status::text IN ('approved', 'overdue', 'penalized')
       AND sp.status = 'pending'
       AND sp.period_start <= now()
     RETURNING sp.id, ds.driver_id AS "driverId"`,
  );

  // 3) Deferred reactivation (auto): settling the debt does not put the driver
  // back on the road instantly - he rejoins on the next anchor day.
  const scheduled = await db.query<{ driverId: string }>(
    `UPDATE drivers d
        SET reactivates_at =
              ((date_trunc('week', (now() AT TIME ZONE $1)) + interval '7 days') AT TIME ZONE $1)
      WHERE d.status::text = 'penalized'
        AND d.reactivates_at IS NULL
        AND $2::text = 'auto'
        AND NOT EXISTS (
          SELECT 1 FROM subscription_payments sp
          JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
          WHERE ds.driver_id = d.user_id AND sp.status = 'overdue'
        )
      RETURNING d.user_id AS "driverId"`,
    [cfg.timezone, cfg.reactivationMode],
  );

  // 4) Derive the driver state from the accumulated debt.
  const moved = await db.query<{ driverId: string; status: string; weeks: number }>(
    `WITH debt AS (
       SELECT ds.driver_id, count(*)::int AS weeks
       FROM subscription_payments sp
       JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
       WHERE sp.status = 'overdue'
         -- A covered period charge is not debt (defence in depth): only count an
         -- overdue week whose period is NOT within the paid coverage. Penalties
         -- always count. Root-cause fix 2026-07-29.
         AND (sp.charge_kind <> 'period' OR sp.period_start >= COALESCE(
               (SELECT max(cov.period_end) FROM subscription_payments cov
                WHERE cov.driver_subscription_id = sp.driver_subscription_id
                  AND cov.status = 'paid' AND cov.charge_kind = 'period'), sp.period_start))
       GROUP BY ds.driver_id
     ), target AS (
       SELECT d.user_id,
              COALESCE(x.weeks, 0) AS weeks,
              (CASE
                 WHEN COALESCE(x.weeks, 0) = 0
                      AND (d.reactivates_at IS NULL OR d.reactivates_at <= now()) THEN 'approved'
                 WHEN COALESCE(x.weeks, 0) = 0 THEN 'penalized'
                 WHEN COALESCE(x.weeks, 0) <= $1 THEN 'overdue'
                 ELSE 'penalized'
               END)::driver_status AS new_status
       FROM drivers d
       LEFT JOIN debt x ON x.driver_id = d.user_id
       WHERE d.status::text IN ('approved', 'overdue', 'penalized')
     )
     UPDATE drivers dr
        SET status = t.new_status,
            reactivates_at = CASE WHEN t.new_status = 'approved' THEN NULL
                                  ELSE dr.reactivates_at END
     FROM target t
     WHERE dr.user_id = t.user_id AND dr.status IS DISTINCT FROM t.new_status
     RETURNING dr.user_id AS "driverId", dr.status::text AS status, t.weeks`,
    [cfg.debtCapWeeks],
  );

  // 5) Penalty fine, charged ONLY on the transition into `penalized` (one fine
  // per penalization episode). Charging every penalized driver without an
  // unpaid fine would re-fine someone who already settled and is merely waiting
  // for the reactivation moment, dragging him back into debt.
  const justPenalized = moved.rows.filter((r) => r.status === 'penalized').map((r) => r.driverId);
  const penalties = justPenalized.length
    ? await db.query<{ id: string; driverId: string }>(
        `WITH ins AS (
           INSERT INTO subscription_payments
             (driver_subscription_id, period_start, period_end, amount_usd, status, charge_kind)
           SELECT ds.id, now(), now() + make_interval(weeks => $1),
                  p.price_usd * $1, 'pending', 'penalty'
           FROM driver_subscriptions ds
           JOIN subscription_plans p ON p.id = ds.plan_id
           JOIN drivers d ON d.user_id = ds.driver_id
           WHERE d.user_id = ANY($2::uuid[])
             AND d.status::text = 'penalized'
             AND ds.status = 'active'
             AND p.billing_period = 'weekly'
             AND NOT EXISTS (
               SELECT 1 FROM subscription_payments x
               WHERE x.driver_subscription_id = ds.id
                 AND x.charge_kind = 'penalty'
                 AND x.status IN ('pending', 'overdue')
             )
           RETURNING id, driver_subscription_id
         )
         SELECT i.id, ds.driver_id AS "driverId"
         FROM ins i JOIN driver_subscriptions ds ON ds.id = i.driver_subscription_id`,
        [cfg.penaltyWeeks, justPenalized],
      )
    : { rows: [] as { id: string; driverId: string }[], rowCount: 0 };

  for (const row of issued.rows) {
    await writeAudit(db, {
      eventType: 'subscription.charge_issued',
      entity: 'subscription_payments',
      entityId: row.id,
      data: { driverId: row.driverId },
    });
  }
  for (const row of overdue.rows) {
    await writeAudit(db, {
      eventType: 'subscription.payment_overdue',
      entity: 'subscription_payments',
      entityId: row.id,
      data: { driverId: row.driverId },
    });
  }
  for (const row of penalties.rows) {
    await writeAudit(db, {
      eventType: 'subscription.penalty_issued',
      entity: 'subscription_payments',
      entityId: row.id,
      data: { driverId: row.driverId, weeks: cfg.penaltyWeeks },
    });
  }
  for (const row of scheduled.rows) {
    await writeAudit(db, {
      eventType: 'driver.reactivation_scheduled',
      entity: 'drivers',
      entityId: row.driverId,
      data: { driverId: row.driverId, mode: cfg.reactivationMode },
    });
  }
  for (const row of moved.rows) {
    const eventType =
      row.status === 'penalized'
        ? 'driver.penalized'
        : row.status === 'overdue'
          ? 'driver.overdue'
          : 'driver.debt_cleared';
    await writeAudit(db, {
      eventType,
      entity: 'drivers',
      entityId: row.driverId,
      data: { driverId: row.driverId, weeksOwed: row.weeks },
    });
  }

  return {
    enabled: true,
    issued: issued.rowCount ?? 0,
    markedOverdue: overdue.rowCount ?? 0,
    penaltiesIssued: penalties.rowCount ?? 0,
    scheduledReactivations: scheduled.rowCount ?? 0,
    moved: moved.rows,
  };
}

/**
 * Debt engine job: runs the pass above every minute and on boot, same cadence
 * and shape as the tariff/document schedulers. Does nothing while the master
 * switch is off, so registering it never changes the cobro by itself.
 */
export default fp(
  async (app) => {
    let running = false;

    const tick = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        const result = await runDebtEngineTick(app.db);
        for (const row of result.moved) {
          app.log.info(
            { driverId: row.driverId, status: row.status, weeks: row.weeks },
            'debt engine moved driver',
          );
        }
      } catch (err) {
        app.log.error(err, 'debt scheduler tick failed');
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), TICK_MS);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));

    void tick(); // catch up on boot (covers server downtime)
  },
  { name: 'debt-scheduler', dependencies: ['db'] },
);
