import type { FastifyPluginAsync } from 'fastify';
import { SettingsRepository } from '../settings/settings.repository.js';
import { DashboardRepository } from './dashboard.repository.js';
import { DashboardService } from './dashboard.service.js';

const dashboardRoutes: FastifyPluginAsync = async (app) => {
  const service = new DashboardService(
    new DashboardRepository(app.db),
    new SettingsRepository(app.db),
  );

  app.addHook('onRequest', app.authenticate);

  app.get('/summary', async () => service.summary());

  app.get<{ Querystring: { days?: number } }>(
    '/revenue-series',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            days: { type: 'integer', minimum: 7, maximum: 90, default: 30 },
          },
        },
      },
    },
    async (req) => service.revenueSeries(req.query.days ?? 30),
  );
};

export default dashboardRoutes;
