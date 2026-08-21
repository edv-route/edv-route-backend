import fp from 'fastify-plugin';
import pg from 'pg';

declare module 'fastify' {
  interface FastifyInstance {
    db: pg.Pool;
  }
}

/**
 * PostgreSQL connection pool (Supabase-hosted Postgres with PostGIS).
 * All data access goes through this pool; no other layer opens connections.
 *
 * ## Why the pool is SMALL, and why the size depends on the environment
 *
 * Supabase's session-mode pooler caps the whole project at **15 clients**, and
 * production and development share ONE database (decision 2026-07-27). That
 * ceiling is not per process — it is the sum of everyone connected:
 *
 *     Railway (prod)  8  +  laptop (dev)  3  +  a test run  2..4   =  13..15
 *
 * With the old flat `max: 10` the arithmetic simply did not fit: two backends
 * alone asked for 20 and the pooler started refusing with
 * `(EMAXCONNSESSION) max clients reached in session mode`. Every scheduler tick
 * failed at once, which reads like a database outage and is really two laptops
 * being greedy.
 *
 * A dev pool does not need to be big: one developer and one panel. Production
 * gets the rest. `DATABASE_POOL_MAX` overrides both when the Supabase pool size
 * is raised (Dashboard > Settings > Database > Connection pooling) — the real
 * way to buy headroom, since this file can only divide what there is.
 */
const POOL_MAX_PRODUCTION = 8;
const POOL_MAX_DEVELOPMENT = 3;

export default fp(
  async (app) => {
    const isProduction = app.config.NODE_ENV === 'production';
    const max =
      app.config.DATABASE_POOL_MAX ||
      (isProduction ? POOL_MAX_PRODUCTION : POOL_MAX_DEVELOPMENT);

    const pool = new pg.Pool({
      connectionString: app.config.DATABASE_URL,
      max,
      // Idle clients still hold a slot in the shared pooler. In development the
      // backend spends most of its life idle, so it gives them back quickly
      // instead of sitting on connections nobody else can use.
      idleTimeoutMillis: isProduction ? 30_000 : 5_000,
      connectionTimeoutMillis: 10_000,
    });

    // An idle client can drop (the Supabase pooler recycles connections). Without
    // this listener the pool emits an *unhandled* 'error' event that crashes the
    // whole process; here we log it and let pg discard the dead connection.
    pool.on('error', (err) => {
      app.log.error({ err }, 'idle database client error (connection dropped)');
    });

    // Fail fast: verify connectivity on boot instead of on first request
    await pool.query('SELECT 1');
    app.log.info({ poolMax: max }, 'database connection established');

    app.decorate('db', pool);

    app.addHook('onClose', async () => {
      await pool.end();
    });
  },
  { name: 'db' },
);
