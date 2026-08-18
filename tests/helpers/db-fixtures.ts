import type pg from 'pg';

/**
 * Shared test fixtures. The suite runs against the DEV database, which is also
 * the one the deployed backend uses: another process may be ticking the
 * schedulers while the tests run. Every helper here is written to survive that.
 */

/**
 * Removes a throwaway driver and everything hanging off it, in one transaction.
 * The `FOR UPDATE` on its subscriptions blocks a concurrent scheduler from
 * inserting a charge between the DELETEs (an INSERT into subscription_payments
 * takes a key-share lock on the referenced subscription row) — without it the
 * cleanup fails with a foreign-key violation.
 */
export async function removeDriver(pool: pg.Pool, driverId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM driver_subscriptions WHERE driver_id = $1 FOR UPDATE`, [driverId]);
    // Submissions first (RESTRICT on invoices; CASCADE clears their files; the
    // charges' submission_id is SET NULL on delete). v9.
    await client.query(`DELETE FROM payment_submissions WHERE driver_id = $1`, [driverId]);
    await client.query(
      `DELETE FROM subscription_payments WHERE driver_subscription_id IN
         (SELECT id FROM driver_subscriptions WHERE driver_id = $1)`, [driverId]);
    await client.query(`DELETE FROM membership_payments WHERE driver_id = $1`, [driverId]);
    await client.query(`DELETE FROM invoices WHERE driver_id = $1`, [driverId]);
    await client.query(`DELETE FROM driver_subscriptions WHERE driver_id = $1`, [driverId]);
    await client.query(`DELETE FROM users WHERE id = $1`, [driverId]); // cascades to drivers
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Debt-engine settings as they were before a suite touched them. */
const DEBT_ENGINE_KEYS = ['debt_engine_enabled', 'billing_day_of_week', 'billing_hour'] as const;
let debtEngineSnapshot: { key: string; value: string }[] | null = null;

/**
 * Remembers the CURRENT debt-engine settings so they can be put back exactly as
 * they were. Call it before flipping the switch.
 *
 * This exists because `app_settings` is global and this suite runs against the
 * same database the deployed backend uses: on 2026-08-18 the restore helper
 * hardcoded "master switch OFF", so simply running the tests turned OFF the
 * production debt engine — no weekly charges, no arrears, silently. Restoring a
 * hardcoded value is not restoring; it is overwriting.
 */
export async function snapshotDebtEngineSettings(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ key: string; value: string }>(
    `SELECT key, value::text AS value FROM app_settings WHERE key = ANY($1)`,
    [[...DEBT_ENGINE_KEYS]],
  );
  debtEngineSnapshot = rows;
}

/**
 * Puts the debt-engine settings back to whatever `snapshotDebtEngineSettings`
 * saw. MUST run in an `after()` hook of any suite that flips the switch. Without
 * a snapshot it does nothing, which is safer than guessing.
 */
export async function restoreDebtEngineSettings(pool: pg.Pool): Promise<void> {
  if (!debtEngineSnapshot) return;
  for (const row of debtEngineSnapshot) {
    await pool.query(`UPDATE app_settings SET value = $2::jsonb WHERE key = $1`, [row.key, row.value]);
  }
}
