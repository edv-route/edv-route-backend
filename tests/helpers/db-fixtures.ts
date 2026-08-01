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

/**
 * Debt-engine settings back to their seed values, master switch OFF. MUST run
 * in an `after()` hook of any suite that flips the switch: `app_settings` is
 * global, so a test that dies mid-way would otherwise leave the money engine
 * running for every process pointed at this database.
 */
export async function restoreDebtEngineDefaults(pool: pg.Pool): Promise<void> {
  await pool.query(`UPDATE app_settings SET value = 'false'::jsonb WHERE key = 'debt_engine_enabled'`);
  await pool.query(`UPDATE app_settings SET value = '5'::jsonb WHERE key = 'billing_day_of_week'`);
  await pool.query(`UPDATE app_settings SET value = '18'::jsonb WHERE key = 'billing_hour'`);
}
