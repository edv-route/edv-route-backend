import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { runDebtEngineTick } from '../src/plugins/debt-scheduler.js';
import { EnrollmentRepository } from '../src/modules/drivers/enrollment.repository.js';
import { DriversRepository } from '../src/modules/drivers/drivers.repository.js';
import { removeDriver as removeDriverFixture, restoreDebtEngineDefaults } from './helpers/db-fixtures.js';

/**
 * Integration tests for the debt & penalty engine (design v8). They run the
 * real `runDebtEngineTick` against the database, so no HTTP server / port is
 * needed. Each test creates its own throwaway driver and removes it in a
 * finally block, so the shared dev DB is left exactly as found. The engine
 * master switch is flipped on for the test and restored to false afterwards.
 */

let pool: pg.Pool;
let repo: DriversRepository;

before(() => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  repo = new DriversRepository(pool);
});
after(async () => {
  // Safety net: a test that dies mid-way must NEVER leave the money engine ON.
  await restoreDebtEngineDefaults(pool);
  await pool.end();
});

const setFlag = (on: boolean) =>
  pool.query(`UPDATE app_settings SET value = $1::jsonb WHERE key = 'debt_engine_enabled'`, [String(on)]);

const statusOf = async (driverId: string): Promise<string> =>
  (await pool.query<{ s: string }>('SELECT status::text AS s FROM drivers WHERE user_id = $1', [driverId])).rows[0]!.s;

/** Creates an approved driver with an active WEEKLY subscription. */
async function makeDriver(): Promise<{ driverId: string; subId: string }> {
  const { rows: u } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name) VALUES ('TEST', 'DebtEngine', 'TEST DebtEngine') RETURNING id`,
  );
  const driverId = u[0]!.id;
  await pool.query(`INSERT INTO drivers (user_id, source, status) VALUES ($1, 'admin', 'approved')`, [driverId]);
  const { rows: p } = await pool.query<{ id: number }>(
    `SELECT id FROM subscription_plans WHERE billing_period = 'weekly' AND active ORDER BY id LIMIT 1`,
  );
  assert.ok(p[0], 'necesita una tarifa semanal activa para la prueba');
  const { rows: s } = await pool.query<{ id: string }>(
    `INSERT INTO driver_subscriptions (driver_id, plan_id, status, current_period_start, current_period_end)
     VALUES ($1, $2, 'active', now(), now() + interval '7 days') RETURNING id`,
    [driverId, p[0].id],
  );
  return { driverId, subId: s[0]!.id };
}

const removeDriver = (driverId: string): Promise<void> => removeDriverFixture(pool, driverId);

/** Inserts an unpaid weekly charge whose week already started (= 1 week of debt). */
async function addDebtWeek(subId: string, weeksAgo: number, kind: 'period' | 'penalty' = 'period'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO subscription_payments
       (driver_subscription_id, period_start, period_end, amount_usd, status, charge_kind)
     VALUES ($1, now() - make_interval(weeks => $2), now() - make_interval(weeks => $2 - 1), 10, 'pending', $3)
     RETURNING id`,
    [subId, weeksAgo, kind],
  );
  return rows[0]!.id;
}

/** A PAID period charge from `fromExpr` for `days` days — the prepaid coverage. */
const addPaid = (subId: string, fromExpr: string, days: number): Promise<unknown> =>
  pool.query(
    `INSERT INTO subscription_payments
       (driver_subscription_id, period_start, period_end, amount_usd, status, charge_kind)
     VALUES ($1, ${fromExpr}, ${fromExpr} + make_interval(days => $2), 10, 'paid', 'period')`,
    [subId, days],
  );

/** A tariff charge in an arbitrary window/status (period unless stated). */
const addCharge = (
  subId: string,
  startExpr: string,
  endExpr: string,
  status: string,
  kind: 'period' | 'penalty' = 'period',
): Promise<unknown> =>
  pool.query(
    `INSERT INTO subscription_payments
       (driver_subscription_id, period_start, period_end, amount_usd, status, charge_kind)
     VALUES ($1, ${startExpr}, ${endExpr}, 10, $2, $3)`,
    [subId, status, kind],
  );

const countPendingWeeks = (subId: string): Promise<string> =>
  pool
    .query<{ n: string }>(
      `SELECT count(*)::text AS n FROM subscription_payments
       WHERE driver_subscription_id = $1 AND status = 'pending' AND charge_kind = 'period'`,
      [subId],
    )
    .then((r) => r.rows[0]!.n);

interface DebtView {
  totalUsd: string;
  weeksOwed: number;
  penaltyCount: number;
  capWeeks: number;
  charges: unknown[];
}
type UpcomingView = { amountUsd: string; periodStart: string; periodEnd: string } | null;

test('flag OFF: the engine is inert (cobro unchanged)', async () => {
  await setFlag(false);
  const { driverId, subId } = await makeDriver();
  try {
    await addDebtWeek(subId, 1);
    const r = await runDebtEngineTick(pool);
    assert.equal(r.enabled, false);
    assert.equal(r.markedOverdue, 0);
    assert.equal(r.moved.length, 0);
    assert.equal(await statusOf(driverId), 'approved', 'no debe moverse con el motor apagado');
  } finally {
    await removeDriver(driverId);
  }
});

test('debt cycle: overdue -> penalized (+fine) -> settle -> approved', async () => {
  await setFlag(true);
  const { driverId, subId } = await makeDriver();
  try {
    // 1 unpaid week -> overdue (still operates)
    await addDebtWeek(subId, 1);
    await runDebtEngineTick(pool);
    assert.equal(await statusOf(driverId), 'overdue', '1 semana impaga = en mora');

    // beyond the cap (3 > 2) -> penalized, and a single penalty fine is issued
    await addDebtWeek(subId, 2);
    await addDebtWeek(subId, 3);
    const r = await runDebtEngineTick(pool);
    assert.equal(await statusOf(driverId), 'penalized', '3 semanas (tope 2) = penalizado');
    assert.equal(r.penaltiesIssued, 1, 'se emite exactamente una multa');

    // the fine counts as debt: 3 weeks + 1 penalty = 4 outstanding
    await runDebtEngineTick(pool);
    const { rows: owed } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM subscription_payments sp
       JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
       WHERE ds.driver_id = $1 AND sp.status = 'overdue'`, [driverId]);
    assert.equal(owed[0]!.n, '4', 'deuda = 3 semanas + multa');

    // penalized driver receives no new weekly charges (debt frozen at the cap)
    const frozen = await runDebtEngineTick(pool);
    assert.equal(frozen.issued, 0, 'un penalizado no recibe cargos nuevos');

    // settle everything -> in AUTO mode the driver STAYS penalized until the
    // reactivation moment (next Monday): deferred reactivation.
    await pool.query(
      `UPDATE subscription_payments sp SET status = 'paid', paid_at = now()
       FROM driver_subscriptions ds
       WHERE sp.driver_subscription_id = ds.id AND ds.driver_id = $1 AND sp.status = 'overdue'`, [driverId]);
    const settled = await runDebtEngineTick(pool);
    assert.equal(settled.scheduledReactivations, 1, 'programa la reincorporación');
    assert.equal(await statusOf(driverId), 'penalized', 'saldado pero sigue penalizado hasta el lunes (auto)');
    const { rows: ra } = await pool.query<{ r: Date | null }>(
      'SELECT reactivates_at AS r FROM drivers WHERE user_id = $1', [driverId]);
    assert.ok(ra[0]!.r, 'reactivates_at quedó programado');

    // simulate the reactivation moment arriving -> derived back to approved
    await pool.query(`UPDATE drivers SET reactivates_at = now() - interval '1 minute' WHERE user_id = $1`, [driverId]);
    await runDebtEngineTick(pool);
    assert.equal(await statusOf(driverId), 'approved', 'al llegar el lunes vuelve a aprobado');
    const { rows: ra2 } = await pool.query<{ r: Date | null }>(
      'SELECT reactivates_at AS r FROM drivers WHERE user_id = $1', [driverId]);
    assert.equal(ra2[0]!.r, null, 'reactivates_at se limpia al reincorporar');

    // idempotent: nothing else moves
    const again = await runDebtEngineTick(pool);
    assert.equal(again.moved.length, 0, 'idempotente');
  } finally {
    // Switch OFF first: it closes the window in which a scheduler from another
    // process could insert a charge while this driver is being deleted.
    await setFlag(false);
    await removeDriver(driverId);
  }
});

test('anchoring: weekly renew lands on Mondays when ON, now-based when OFF', async () => {
  const repo = new EnrollmentRepository(pool);
  const { rows: a } = await pool.query<{ id: string }>(`SELECT id FROM admins ORDER BY created_at LIMIT 1`);
  assert.ok(a[0], 'necesita un admin para registrar el cobro');
  const adminId = a[0].id;
  const tz = 'America/Caracas';

  // --- anchorWeekly ON: every weekly period is a Monday-to-Monday window ---
  const on = await makeDriver();
  try {
    await repo.renew({
      subscriptionId: on.subId, driverId: on.driverId, planPriceUsd: 10, periods: 2,
      periodInterval: '7 days', timezone: tz, reactivate: true, anchorWeekly: true, registeredBy: adminId,
    });
    const { rows } = await pool.query<{ start: Date; end: Date; dow: number; midnight: boolean }>(
      `SELECT period_start AS start, period_end AS "end",
              extract(isodow from (period_start AT TIME ZONE $2))::int AS dow,
              (period_start AT TIME ZONE $2)::time = time '00:00' AS midnight
       FROM subscription_payments
       WHERE driver_subscription_id = $1 AND status = 'paid'
       ORDER BY period_start`,
      [on.subId, tz],
    );
    assert.equal(rows.length, 2, 'crea 2 semanas pagadas');
    for (const r of rows) {
      assert.equal(r.dow, 1, 'cada período arranca un lunes');
      assert.ok(r.midnight, 'a las 00:00 hora del negocio');
    }
    assert.equal(
      new Date(rows[0]!.end).getTime(), new Date(rows[1]!.start).getTime(),
      'las semanas son consecutivas, sin huecos ni solapes',
    );
  } finally {
    await removeDriver(on.driverId);
  }

  // --- anchorWeekly OFF: prepaid behaviour unchanged (first period from now) ---
  const off = await makeDriver();
  try {
    await repo.renew({
      subscriptionId: off.subId, driverId: off.driverId, planPriceUsd: 10, periods: 1,
      periodInterval: '7 days', timezone: tz, reactivate: true, anchorWeekly: false, registeredBy: adminId,
    });
    const { rows } = await pool.query<{ near: boolean }>(
      `SELECT abs(extract(epoch from (now() - period_start))) < 5 AS near
       FROM subscription_payments
       WHERE driver_subscription_id = $1 AND status = 'paid'
       ORDER BY period_start LIMIT 1`,
      [off.subId],
    );
    assert.ok(rows[0]!.near, 'sin anclaje, el primer período arranca en now()');
  } finally {
    await removeDriver(off.driverId);
  }
});

test('alta anclada: la semana comprada arranca el PRÓXIMO lunes y la tarifa no rige hasta entonces', async () => {
  const repo = new EnrollmentRepository(pool);
  const tz = 'America/Caracas';
  // A pending driver as `enroll` leaves him: scheduled subscription + paid
  // periods with placeholder dates, re-anchored at approval.
  const { rows: u } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name)
     VALUES ('TEST', 'AltaAnclada', 'TEST AltaAnclada') RETURNING id`,
  );
  const driverId = u[0]!.id;
  try {
    await pool.query(`INSERT INTO drivers (user_id, source, status) VALUES ($1, 'admin', 'pending')`, [driverId]);
    const { rows: p } = await pool.query<{ id: number }>(
      `SELECT id FROM subscription_plans WHERE billing_period = 'weekly' AND active ORDER BY id LIMIT 1`,
    );
    const { rows: s } = await pool.query<{ id: string }>(
      `INSERT INTO driver_subscriptions (driver_id, plan_id, status)
       VALUES ($1, $2, 'scheduled') RETURNING id`,
      [driverId, p[0]!.id],
    );
    const subId = s[0]!.id;
    await pool.query(
      `INSERT INTO subscription_payments
         (driver_subscription_id, period_start, period_end, amount_usd, status, paid_at)
       VALUES ($1, now(), now() + interval '7 days', 10, 'paid', now())`,
      [subId],
    );

    await repo.approve(driverId, '7 days', tz, true);

    const { rows } = await pool.query<{
      dow: number; midnight: boolean; future: boolean; withinAWeek: boolean; today_is_monday: boolean;
    }>(
      `SELECT extract(isodow from (period_start AT TIME ZONE $2))::int AS dow,
              (period_start AT TIME ZONE $2)::time = time '00:00' AS midnight,
              period_start > now() AS future,
              period_start <= now() + interval '7 days' AS "withinAWeek",
              extract(isodow from (now() AT TIME ZONE $2))::int = 1 AS today_is_monday
       FROM subscription_payments WHERE driver_subscription_id = $1`,
      [subId, tz],
    );
    const week = rows[0]!;
    assert.equal(week.dow, 1, 'la semana comprada arranca un lunes');
    assert.ok(week.midnight, 'a las 00:00 hora del negocio');
    assert.ok(week.withinAWeek, 'es el lunes inmediato, no uno lejano');
    // Paying on a Monday buys the week already running; any other day, the next one.
    assert.equal(week.future, !week.today_is_monday,
      week.today_is_monday
        ? 'pagando un lunes, la semana en curso arranca ya'
        : 'pagando cualquier otro día, la semana arranca el lunes siguiente');

    const { rows: sub } = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM driver_subscriptions WHERE id = $1`, [subId]);
    assert.equal(
      sub[0]!.status, week.today_is_monday ? 'active' : 'scheduled',
      'la tarifa no rige hasta que empieza su semana: queda programada',
    );
  } finally {
    await removeDriver(driverId);
  }
});

test('anchoring: resume re-anchors weekly coverage to Mondays when ON', async () => {
  const repo = new EnrollmentRepository(pool);
  const tz = 'America/Caracas';
  const { driverId, subId } = await makeDriver();
  try {
    // Paused driver with two future moving-window paid weeks (NOT Monday-aligned).
    await pool.query(
      `UPDATE drivers SET status = 'paused', paused_at = now() - interval '2 days' WHERE user_id = $1`,
      [driverId],
    );
    await pool.query(
      `INSERT INTO subscription_payments
         (driver_subscription_id, period_start, period_end, amount_usd, status, charge_kind)
       VALUES ($1, now() + interval '2 days', now() + interval '9 days', 10, 'paid', 'period'),
              ($1, now() + interval '9 days', now() + interval '16 days', 10, 'paid', 'period')`,
      [subId],
    );

    await repo.resume(driverId, tz, true);

    const { rows } = await pool.query<{ start: Date; end: Date; dow: number; midnight: boolean }>(
      `SELECT period_start AS start, period_end AS "end",
              extract(isodow from (period_start AT TIME ZONE $2))::int AS dow,
              (period_start AT TIME ZONE $2)::time = time '00:00' AS midnight
       FROM subscription_payments
       WHERE driver_subscription_id = $1 AND status = 'paid'
       ORDER BY period_start`,
      [subId, tz],
    );
    assert.equal(rows.length, 2, 're-ancla las 2 semanas de cobertura');
    for (const r of rows) {
      assert.equal(r.dow, 1, 'cada semana arranca un lunes');
      assert.ok(r.midnight, 'a las 00:00 hora del negocio');
    }
    assert.equal(
      new Date(rows[0]!.end).getTime(), new Date(rows[1]!.start).getTime(),
      'semanas consecutivas',
    );
    assert.equal(await statusOf(driverId), 'approved', 'reanudar deja al chofer aprobado');
  } finally {
    await removeDriver(driverId);
  }
});

test('ciclo v8 anclado: emite el lunes correcto (monto ok), idempotente, deriva mora y saldado', async () => {
  await setFlag(true);
  // Force the emission moment to Monday 00:00 so emit_at is always past this week
  // (deterministic, independent of the weekday the suite runs on).
  await pool.query(`UPDATE app_settings SET value = '1'::jsonb WHERE key = 'billing_day_of_week'`);
  await pool.query(`UPDATE app_settings SET value = '0'::jsonb WHERE key = 'billing_hour'`);
  const tz = 'America/Caracas';
  const { driverId, subId } = await makeDriver();
  // Scoped to THIS driver: the engine is global (processes every active weekly
  // sub), so parallel test files' drivers pollute the global `issued` counter.
  const pendingWeeks = async (): Promise<string> =>
    (await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM subscription_payments
       WHERE driver_subscription_id = $1 AND status = 'pending' AND charge_kind = 'period'`,
      [subId])).rows[0]!.n;
  const debt = async (): Promise<string> =>
    (await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM subscription_payments sp
       JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
       WHERE ds.driver_id = $1 AND sp.status = 'overdue'`, [driverId])).rows[0]!.n;
  try {
    // (1) Engine emits next week's charge FOR THIS DRIVER, on NEXT Monday, weekly amount.
    await runDebtEngineTick(pool);
    const { rows: emitted } = await pool.query<{ dow: number; amount: string; onnext: boolean }>(
      `SELECT extract(isodow from (period_start AT TIME ZONE $2))::int AS dow,
              amount_usd::text AS amount,
              period_start = (date_trunc('week', now() AT TIME ZONE $2) + interval '7 days') AT TIME ZONE $2 AS onnext
       FROM subscription_payments
       WHERE driver_subscription_id = $1 AND status = 'pending' AND charge_kind = 'period'`,
      [subId, tz],
    );
    assert.equal(emitted.length, 1, 'un cargo pendiente para este chofer');
    assert.equal(emitted[0]!.dow, 1, 'el cargo arranca un lunes');
    assert.ok(emitted[0]!.onnext, 'es la semana del próximo lunes');
    assert.equal(emitted[0]!.amount, '10.00', 'monto = tarifa semanal ($10)');
    assert.equal(await statusOf(driverId), 'approved', 'al día: sigue aprobado');

    // (2) Idempotent: another tick does not duplicate THIS driver's next-week charge.
    await runDebtEngineTick(pool);
    assert.equal(await pendingWeeks(), '1', 'no re-emite la misma semana (guard de idempotencia)');

    // (3) The week arrives unpaid -> the pending becomes overdue, debt = 1, mora.
    await pool.query(
      `UPDATE subscription_payments SET period_start = now() - interval '1 hour'
       WHERE driver_subscription_id = $1 AND status = 'pending' AND charge_kind = 'period'`,
      [subId],
    );
    await runDebtEngineTick(pool);
    assert.equal(await statusOf(driverId), 'overdue', '1 semana impaga = en mora');
    assert.equal(await debt(), '1', 'deuda = exactamente 1 semana');

    // (4) Settle it -> debt clears, driver derives back to approved.
    await pool.query(
      `UPDATE subscription_payments SET status = 'paid', paid_at = now()
       FROM driver_subscriptions ds
       WHERE subscription_payments.driver_subscription_id = ds.id
         AND ds.driver_id = $1 AND subscription_payments.status = 'overdue'`, [driverId]);
    await runDebtEngineTick(pool);
    assert.equal(await debt(), '0', 'sin deuda tras saldar');
    assert.equal(await statusOf(driverId), 'approved', 'saldado = aprobado');
  } finally {
    await restoreDebtEngineDefaults(pool);
    await removeDriver(driverId);
  }
});

// --- Coverage-aware debt model (root-cause fix 2026-07-29) ---

test('engine: does not bill a week already covered by paid coverage (no phantom charge)', async () => {
  await setFlag(true);
  // Deterministic emission moment: Monday 00:00 so emit_at is always in the past.
  await pool.query(`UPDATE app_settings SET value = '1'::jsonb WHERE key = 'billing_day_of_week'`);
  await pool.query(`UPDATE app_settings SET value = '0'::jsonb WHERE key = 'billing_hour'`);
  const covered = await makeDriver();
  const bare = await makeDriver();
  try {
    // Covered driver: coverage runs 30 days out (well past next Monday).
    await addPaid(covered.subId, 'now()', 30);
    await runDebtEngineTick(pool);
    assert.equal(await countPendingWeeks(covered.subId), '0', 'una semana cubierta NO se cobra');
    assert.equal(await countPendingWeeks(bare.subId), '1', 'sin cobertura SÍ se cobra la próxima semana');
  } finally {
    await restoreDebtEngineDefaults(pool);
    await removeDriver(covered.driverId);
    await removeDriver(bare.driverId);
  }
});

test('findDetail: splits overdue DEBT from the not-yet-due UPCOMING charge, exposes capWeeks', async () => {
  const { driverId, subId } = await makeDriver();
  try {
    // An overdue (past-due, uncovered) week = real debt (red band).
    await addCharge(subId, `now() - interval '2 days'`, `now() + interval '5 days'`, 'overdue');
    // A pending (future, uncovered) week = the upcoming charge (amber band).
    await addCharge(subId, `now() + interval '3 days'`, `now() + interval '10 days'`, 'pending');

    const detail = (await repo.findDetail(driverId))!;
    const debt = detail['debt'] as DebtView;
    const upcoming = detail['upcoming'] as UpcomingView;

    assert.equal(debt.weeksOwed, 1, 'la deuda cuenta solo la semana vencida');
    assert.equal(debt.charges.length, 1, 'debt.charges = solo el cargo vencido');
    assert.equal(debt.capWeeks, 2, 'expone el tope de deuda (advertencia de suspensión)');
    // debt.totalUsd is what the approval debt-lock reads: > 0 blocks approve.
    assert.ok(Number(debt.totalUsd) > 0, 'hay deuda vencida -> el candado de aprobación bloquearía');
    assert.ok(upcoming, 'el cargo pendiente aparece como próximo cobro');
    assert.equal(upcoming!.amountUsd, '10.00', 'monto del próximo cobro');
  } finally {
    await removeDriver(driverId);
  }
});

test('findDetail: a charge covered by an advance is hidden from BOTH debt and upcoming (Ruth case)', async () => {
  const { driverId, subId } = await makeDriver();
  try {
    // Coverage paid 30 days out (advance).
    await addPaid(subId, 'now()', 30);
    // Phantom charges INSIDE the covered window (period_start < paidUntil).
    await addCharge(subId, `now() + interval '3 days'`, `now() + interval '10 days'`, 'pending');
    await addCharge(subId, `now() - interval '1 days'`, `now() + interval '6 days'`, 'overdue');

    const detail = (await repo.findDetail(driverId))!;
    const debt = detail['debt'] as DebtView;
    const upcoming = detail['upcoming'] as UpcomingView;

    assert.equal(debt.weeksOwed, 0, 'nada vencido: la semana ya está cubierta');
    assert.equal(debt.charges.length, 0, 'sin deuda visible');
    assert.equal(Number(debt.totalUsd), 0, 'sin deuda -> el candado de aprobación NO bloquearía');
    assert.equal(upcoming, null, 'sin próximo cobro: ya está pagado por adelantado');
  } finally {
    await removeDriver(driverId);
  }
});
