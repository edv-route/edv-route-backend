import type { FastifyPluginAsync } from 'fastify';
import { LocationsReadRepository } from './locations.read.repository.js';
import { LocationsAdminService } from './locations.admin.service.js';

/**
 * What the panel reads to draw the map and the trails (proposal:
 * docs/proposals/ubicacion-afiliados/fase-4-mapa.md).
 *
 * A separate plugin from `locations.routes.ts` on purpose: that one is the
 * driver's write path, guarded by the driver token and running in production
 * every ten minutes. Mixing both guards in one plugin is how a hook ends up
 * applied to the wrong route.
 */

const liveQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    /** Hide positions the phone itself flagged as worse than this many metres. */
    maxAccuracyM: { type: 'integer', minimum: 1, maximum: 100000 },
    /** Only affiliates whose position moved after this instant (incremental refresh). */
    since: { type: 'string', format: 'date-time' },
  },
} as const;

const historyParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const historyQuery = {
  type: 'object',
  required: ['from', 'to'],
  additionalProperties: false,
  properties: {
    // Full instants with offset, never a calendar day: the server does not
    // guess whether the day starts in Caracas or in UTC.
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
  },
} as const;

const locationsAdminRoutes: FastifyPluginAsync = async (app) => {
  const service = new LocationsAdminService(app, new LocationsReadRepository(app.db));

  app.addHook('onRequest', app.authenticate);

  app.get<{ Querystring: { maxAccuracyM?: number; since?: string } }>(
    '/live',
    { schema: { querystring: liveQuery } },
    async (req) =>
      service.live({
        ...(req.query.maxAccuracyM !== undefined ? { maxAccuracyM: req.query.maxAccuracyM } : {}),
        ...(req.query.since !== undefined ? { since: new Date(req.query.since) } : {}),
      }),
  );

  app.get<{ Params: { id: string }; Querystring: { from: string; to: string } }>(
    '/drivers/:id/history',
    { schema: { params: historyParams, querystring: historyQuery } },
    async (req) =>
      service.history(
        req.params.id,
        new Date(req.query.from),
        new Date(req.query.to),
        req.user.sub,
      ),
  );
};

export default locationsAdminRoutes;
