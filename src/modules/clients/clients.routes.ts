import type { FastifyPluginAsync } from 'fastify';
import { ClientsRepository } from './clients.repository.js';
import { ClientsService } from './clients.service.js';

/**
 * Panel section «Clientes» (2026-08-31): the admin's list of passengers,
 * mirroring the affiliates list — search + pagination, avatars signed in
 * batch. LIST ONLY for now (decision by Luis): no detail card, no actions.
 * Guarded by the ADMIN token; the passenger's own channel is `/client-auth`.
 */
const clientsRoutes: FastifyPluginAsync = async (app) => {
  const service = new ClientsService(app, new ClientsRepository(app.db));

  app.addHook('onRequest', app.authenticate);

  app.get<{
    Querystring: { status?: string; search?: string; page?: number; limit?: number };
  }>(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['active', 'suspended'] },
            search: { type: 'string', maxLength: 100 },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req) =>
      service.list({
        ...(req.query.status !== undefined ? { status: req.query.status } : {}),
        ...(req.query.search !== undefined ? { search: req.query.search } : {}),
        page: req.query.page ?? 1,
        limit: req.query.limit ?? 20,
      }),
  );
};

export default clientsRoutes;
