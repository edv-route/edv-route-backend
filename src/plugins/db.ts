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
