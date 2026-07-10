import type { FastifyPluginAsync } from 'fastify';

/**
 * Liveness/readiness endpoints. Also reports PostGIS availability so a
 * misconfigured database is caught before any geospatial feature ships.
 */
const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => {
    const { rows } = await app.db.query<{ db_time: string }>(
      'SELECT now() AS db_time',
    );

    let postgisVersion: string | null = null;
    try {
      const result = await app.db.query<{ version: string }>(
        'SELECT postgis_lib_version() AS version',
      );
      postgisVersion = result.rows[0]?.version ?? null;
    } catch {
      // PostGIS extension not enabled yet - reported as null, not an error
    }

    return {
      status: 'ok',
      dbTime: rows[0]?.db_time ?? null,
      postgis: postgisVersion,
    };
  });
};

export default healthRoutes;
