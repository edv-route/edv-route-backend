import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { runDebtEngineTick } from '../src/plugins/debt-scheduler.js';

/**
 * Integration tests for the debt & penalty engine (design v8). They run the
 * real `runDebtEngineTick` against the database, so no HTTP server / port is
 * needed. Each test creates its own throwaway driver and removes it in a
 * finally block, so the shared dev DB is left exactly as found. The engine
 * master switch is flipped on for the test and restored to false afterwards.
 */

let pool: pg.Pool;

before(() => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
});
after(async () => {
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

async function removeDriver(driverId: string): Promise<void> {
  await pool.query(
    `DELETE FROM subscription_payments WHERE driver_subscription_id IN
       (SELECT id FROM driver_subscriptions WHERE driver_id = $1)`, [driverId]);
  await pool.query(`DELETE FROM membership_payments WHERE driver_id = $1`, [driverId]);
  await pool.query(`DELETE FROM invoices WHERE driver_id = $1`, [driverId]);
  await pool.query(`DELETE FROM driver_subscriptions WHERE driver_id = $1`, [driverId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [driverId]); // cascades to drivers
}

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
    await removeDriver(driverId);
    await setFlag(false);
  }
});
