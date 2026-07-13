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
};

export default dashboardRoutes;
