import fp from 'fastify-plugin';
import type pg from 'pg';
import { writeAudit } from '../modules/audit-logs/audit-writer.js';
import { notifyMany, type NotifyManyEntry } from '../modules/notifications/notification-writer.js';

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

interface TickOutcome {
  issued: { driverId: string; amountUsd: string; periodStart: Date }[];
  moved: { driverId: string; status: string; oldStatus: string; weeks: number }[];
  penalties: { driverId: string; amountUsd: string }[];
}

/**
 * Sunday 4pm in the business timezone, derived from the week that starts on
 * Monday at 00:00. Arithmetic on the instant, not on the calendar: Venezuela has
 * no DST, so subtracting 8 hours from Monday 00:00 Caracas lands on Sunday 16:00
 * Caracas, and it stays right even if the server's own clock is UTC.
 */
const REMINDER_HOURS_BEFORE = 8;

/**
 * Turns what the tick just DID into what the affiliate is told.
 *
 * Written right after each step, on the pool - NOT inside the money statements.
 * That is a real difference with the review flows (a rejected payment carries its
 * notice inside its own transaction) and it is the engine's own shape, not a
 * shortcut: the tick is a sequence of independent statements, each already
 * committed, exactly like the audit entries a few lines above. Wrapping the whole
 * engine in one transaction to gain atomicity for a message would hold money row
 * locks for the length of the pass.
 *
 * State changes are read from `moved`, never from the raw charge rows: what the
 * driver needs to hear is what happened to HIM (he is in arrears, he cannot work,
 * he is back on the road), not that a row changed status. Which is also why the
 * old status matters - "cuenta reactivada" is only true coming from `penalized`.
 */
async function notifyTick(db: pg.Pool, cfg: EngineConfig, tick: TickOutcome): Promise<void> {
  const entries: NotifyManyEntry[] = [];

  for (const row of tick.issued) {
    entries.push({
      userId: row.driverId,
      message: {
        type: 'charge_issued',
        amountUsd: row.amountUsd,
        weekStart: row.periodStart,
      },
      payload: { amountUsd: row.amountUsd, weekStart: row.periodStart.toISOString() },
    });
    // A single heads-up the evening before the week starts (decision: one
    // reminder, not one a day). Scheduled here, in the same pass that emits the
    // charge, so no second job has to re-derive who owes what. Paying it cancels
    // the reminder (see the payments repository) - a reminder about something
    // already settled is noise, and noise is what gets notifications muted.
    entries.push({
      userId: row.driverId,
      message: {
        type: 'charge_reminder',
        amountUsd: row.amountUsd,
        weekStart: row.periodStart,
      },
      deliverAfter: new Date(
        row.periodStart.getTime() - REMINDER_HOURS_BEFORE * 60 * 60 * 1000,
      ),
      payload: { amountUsd: row.amountUsd, weekStart: row.periodStart.toISOString() },
    });
  }

  const fineByDriver = new Map(tick.penalties.map((p) => [p.driverId, p.amountUsd]));
  for (const row of tick.moved) {
    if (row.status === 'overdue') {
      entries.push({
        userId: row.driverId,
        // Arrears are marked at 00:05; the message waits for a decent hour.
        // Separating the two is the whole reason `deliver_after` exists.
        deliverAfter: nextMorning(cfg.timezone),
        message: { type: 'debt_overdue', weeks: row.weeks },
        payload: { weeksOwed: row.weeks },
      });
    } else if (row.status === 'penalized') {
      const fine = fineByDriver.get(row.driverId);
      entries.push({
        userId: row.driverId,
        deliverAfter: nextMorning(cfg.timezone),
        message: {
          type: 'penalty_applied',
          capWeeks: cfg.debtCapWeeks,
          ...(fine === undefined ? {} : { fineUsd: fine }),
        },
        payload: { weeksOwed: row.weeks, ...(fine === undefined ? {} : { fineUsd: fine }) },
      });
    } else if (row.status === 'approved' && row.oldStatus === 'penalized') {
      // Only from `penalized`. An overdue driver who paid was never off the road,
      // and telling him he "can work again" would be nonsense.
      entries.push({ userId: row.driverId, message: { type: 'driver_reactivated' } });
    }
  }

  await notifyMany(db, entries);
}

/**
 * 7:00 am in the business timezone, today if it has not passed yet, tomorrow
 * otherwise. Bad news that lands at five past midnight wakes people up for
 * something they cannot act on until the office opens.
 */
function nextMorning(timezone: string): Date {
  const now = new Date();
  const hourThere = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(now),
  );
  const hoursUntilSeven = hourThere < 7 ? 7 - hourThere : 24 - hourThere + 7;
  return new Date(now.getTime() + hoursUntilSeven * 60 * 60 * 1000);
}

/**
 * One pass of the debt & penalty engine (design v8, Fase B). Exported so it can
 * be driven directly by tests instead of waiting for the timer.
 *
 * Master switch: `debt_engine_enabled`. While false this returns immediately
 * and the prepaid model keeps running untouched. Scope: **weekly plans only**.
 *
 *  1. Issues next week's charge (`pending`, week starting next Monday) WITH its
 *     own debt invoice (one per concept, 2026-08-04), once the billing moment has
 *     passed; a receipt cancels the invoice when the week is actually paid.
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

  // 1) Issue next week's charge WITH its own debt invoice (billing redesign
  // 2026-08-04: every charge carries an invoice from the moment it is owed, one
  // per concept). date_trunc('week') anchors on Monday (week_anchor_day = 1). The
  // invoice has no receipt yet — a receipt cancels it when the week is paid.
  const issued = await db.query<{
    id: string;
    driverId: string;
    amountUsd: string;
    periodStart: Date;
  }>(
    `WITH moment AS (
       SELECT date_trunc('week', (now() AT TIME ZONE $1)) AS week_start,
              date_trunc('week', (now() AT TIME ZONE $1))
                + make_interval(days => $2 - 1, hours => $3) AS emit_at,
              date_trunc('week', (now() AT TIME ZONE $1)) + interval '7 days' AS next_start
     ), eligible AS (
       SELECT ds.id AS sub_id, ds.driver_id, p.price_usd,
              (m.next_start AT TIME ZONE $1) AS ps,
              ((m.next_start + interval '7 days') AT TIME ZONE $1) AS pe
       FROM driver_subscriptions ds
       JOIN subscription_plans p ON p.id = ds.plan_id
       JOIN drivers d ON d.user_id = ds.driver_id
       CROSS JOIN moment m
       WHERE ds.status = 'active'
         AND p.billing_period = 'weekly'
         AND d.status::text IN ('approved', 'overdue')
         -- An approved driver whose tariff start is not set yet (solicitudes-app)
         -- is frozen: no weekly charge until the admin sets the start.
         AND d.tariff_start_set_at IS NOT NULL
         -- v9: freeze a driver with a pending payment submission (he already paid
         -- and is awaiting review) — do NOT emit next week's charge until it is
         -- approved or rejected (matches steps 2, 4 and 5). Prevents both a free
         -- week and a double charge while a receipt sits under review.
         AND NOT EXISTS (
           SELECT 1 FROM payment_submissions ps
           WHERE ps.driver_id = ds.driver_id AND ps.status = 'pending'
         )
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
     ), new_invoices AS (
       INSERT INTO invoices (driver_id, total_usd)
       SELECT driver_id, price_usd FROM eligible
       RETURNING id AS invoice_id, driver_id
     ), ins AS (
       INSERT INTO subscription_payments
         (driver_subscription_id, invoice_id, period_start, period_end, amount_usd, status)
       SELECT e.sub_id, ni.invoice_id, e.ps, e.pe, e.price_usd, 'pending'
       FROM eligible e JOIN new_invoices ni ON ni.driver_id = e.driver_id
       RETURNING id, driver_subscription_id, amount_usd, period_start
     )
     SELECT i.id, ds.driver_id AS "driverId",
            i.amount_usd AS "amountUsd", i.period_start AS "periodStart"
     FROM ins i JOIN driver_subscriptions ds ON ds.id = i.driver_subscription_id`,
    [cfg.timezone, cfg.billingDayOfWeek, cfg.billingHour],
  );

  // 2) Charges whose week already started and were not paid = debt. Only for
  // operating drivers (approved/overdue): a `pending` driver's alta-debt week
  // must NOT be flipped to overdue by the engine — it settles at approval.
  // v9: a driver with a pending payment submission is FROZEN (he already paid
  // and is awaiting review) — no new arrears while it is under review.
  const overdue = await db.query<{ id: string; driverId: string }>(
    `UPDATE subscription_payments sp SET status = 'overdue'
     FROM driver_subscriptions ds
     JOIN drivers d ON d.user_id = ds.driver_id
     WHERE sp.driver_subscription_id = ds.id
       AND d.status::text IN ('approved', 'overdue', 'penalized')
       -- Frozen until the tariff start is set (solicitudes-app): the alta-debt
       -- week of an approved-without-start driver must NOT be flipped to overdue.
       AND d.tariff_start_set_at IS NOT NULL
       AND sp.status = 'pending'
       AND sp.period_start <= now()
       AND NOT EXISTS (
         SELECT 1 FROM payment_submissions ps
         WHERE ps.driver_id = ds.driver_id AND ps.status = 'pending'
       )
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
  const moved = await db.query<{
    driverId: string;
    status: string;
    weeks: number;
    oldStatus: string;
  }>(
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
              -- The pre-update value: inside this statement every other reference
              -- to the drivers table still sees the old snapshot. It is what tells
              -- a REACTIVATION (penalized -> approved) apart from a driver who was
              -- merely overdue and paid: two very different messages.
              d.status::text AS old_status,
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
         -- Skip approved-without-start drivers (solicitudes-app): their state is
         -- not derived from debt until the admin sets the tariff start.
         AND d.tariff_start_set_at IS NOT NULL
         -- v9: freeze drivers with a pending submission (awaiting review): their
         -- state does not move until the payment is approved or rejected.
         AND NOT EXISTS (
           SELECT 1 FROM payment_submissions ps
           WHERE ps.driver_id = d.user_id AND ps.status = 'pending'
         )
     )
     UPDATE drivers dr
        SET status = t.new_status,
            reactivates_at = CASE WHEN t.new_status = 'approved' THEN NULL
                                  ELSE dr.reactivates_at END
     FROM target t
     WHERE dr.user_id = t.user_id AND dr.status IS DISTINCT FROM t.new_status
     RETURNING dr.user_id AS "driverId", dr.status::text AS status, t.weeks,
               t.old_status AS "oldStatus"`,
    [cfg.debtCapWeeks],
  );

  // 5) Penalty fine, charged ONLY on the transition into `penalized` (one fine
  // per penalization episode). Charging every penalized driver without an
  // unpaid fine would re-fine someone who already settled and is merely waiting
  // for the reactivation moment, dragging him back into debt.
  const justPenalized = moved.rows.filter((r) => r.status === 'penalized').map((r) => r.driverId);
  const penalties = justPenalized.length
    ? await db.query<{ id: string; driverId: string; amountUsd: string }>(
        `WITH eligible AS (
           SELECT ds.id AS sub_id, ds.driver_id, p.price_usd * $1 AS amount
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
             AND NOT EXISTS (
               SELECT 1 FROM payment_submissions ps
               WHERE ps.driver_id = d.user_id AND ps.status = 'pending'
             )
         ), new_invoices AS (
           INSERT INTO invoices (driver_id, total_usd)
           SELECT driver_id, amount FROM eligible
           RETURNING id AS invoice_id, driver_id
         ), ins AS (
           INSERT INTO subscription_payments
             (driver_subscription_id, invoice_id, period_start, period_end,
              amount_usd, status, charge_kind)
           SELECT e.sub_id, ni.invoice_id, now(), now() + make_interval(weeks => $1::int),
                  e.amount, 'pending', 'penalty'
           FROM eligible e JOIN new_invoices ni ON ni.driver_id = e.driver_id
           RETURNING id, driver_subscription_id, amount_usd
         )
         SELECT i.id, ds.driver_id AS "driverId", i.amount_usd AS "amountUsd"
         FROM ins i JOIN driver_subscriptions ds ON ds.id = i.driver_subscription_id`,
        [cfg.penaltyWeeks, justPenalized],
      )
    : { rows: [] as { id: string; driverId: string; amountUsd: string }[], rowCount: 0 };

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

  await notifyTick(db, cfg, {
    issued: issued.rows,
    moved: moved.rows,
    penalties: penalties.rows,
  });

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
    // Producción y desarrollo comparten UNA base de datos: un backend local
    // que programe este timer escribe sobre datos reales. Misma guarda que el
    // despachador de avisos y la purga de ubicación.
    if (app.config.NODE_ENV !== 'production') {
      app.log.info('debt-scheduler: no programado (solo corre en producción · motor de deuda)');
      return;
    }

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
