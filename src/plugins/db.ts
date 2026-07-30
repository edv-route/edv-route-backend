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
 */
export default fp(
  async (app) => {
    const pool = new pg.Pool({
      connectionString: app.config.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
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
    app.log.info('database connection established');

    app.decorate('db', pool);

    app.addHook('onClose', async () => {
      await pool.end();
    });
  },
  { name: 'db' },
);
