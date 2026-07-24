import type pg from 'pg';

/**
 * Runs `fn` inside a single database transaction on a dedicated pooled client:
 * BEGIN, then COMMIT on success or ROLLBACK on any error, always releasing the
 * client. Pass the provided client to every query that must share the unit of
 * work - e.g. creating a driver and charging its first invoice atomically, so
 * a failed payment never leaves an orphan affiliate behind.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
