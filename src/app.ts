import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { loadConfig, type AppConfig } from './config/env.js';
import dbPlugin from './plugins/db.js';
import authPlugin from './plugins/auth.js';
import healthRoutes from './modules/health/health.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import adminsRoutes from './modules/admins/admins.routes.js';
import vehicleTypesRoutes from './modules/vehicle-types/vehicle-types.routes.js';
import requirementsRoutes from './modules/requirements/requirements.routes.js';
import benefitsRoutes from './modules/benefits/benefits.routes.js';
import settingsRoutes from './modules/settings/settings.routes.js';
import membershipsRoutes from './modules/memberships/memberships.routes.js';
import subscriptionPlansRoutes from './modules/subscription-plans/subscription-plans.routes.js';
import driversRoutes from './modules/drivers/drivers.routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
  }
}

/**
 * Builds and wires the Fastify application: config, infrastructure plugins
 * and domain modules. Kept separate from server.ts so tests can build the
 * app without binding a port.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const config = loadConfig();

  const app = Fastify({
    logger:
      config.NODE_ENV === 'development'
        ? {
            level: config.LOG_LEVEL,
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          }
        : { level: config.LOG_LEVEL },
  });

  app.decorate('config', config);

  // Infrastructure plugins
  await app.register(helmet);
  await app.register(cors, { origin: config.CORS_ORIGIN.split(',') });
  await app.register(sensible);
  await app.register(dbPlugin);
  await app.register(authPlugin);

  // Domain modules (versioned API)
  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(adminsRoutes, { prefix: '/admins' });
      await api.register(vehicleTypesRoutes, { prefix: '/vehicle-types' });
      await api.register(requirementsRoutes, { prefix: '/requirements' });
      await api.register(benefitsRoutes, { prefix: '/benefits' });
      await api.register(settingsRoutes, { prefix: '/settings' });
      await api.register(membershipsRoutes, { prefix: '/memberships' });
      await api.register(subscriptionPlansRoutes, { prefix: '/subscription-plans' });
      await api.register(driversRoutes, { prefix: '/drivers' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
