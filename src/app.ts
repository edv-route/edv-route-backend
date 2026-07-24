import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import { loadConfig, type AppConfig } from './config/env.js';
import { MAX_FILE_BYTES } from './storage/storage-provider.js';
import dbPlugin from './plugins/db.js';
import authPlugin from './plugins/auth.js';
import storagePlugin from './plugins/storage.js';
import subscriptionScheduler from './plugins/subscription-scheduler.js';
import documentScheduler from './plugins/document-scheduler.js';
import debtScheduler from './plugins/debt-scheduler.js';
import healthRoutes from './modules/health/health.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import adminsRoutes from './modules/admins/admins.routes.js';
import vehicleTypesRoutes from './modules/vehicle-types/vehicle-types.routes.js';
import requirementsRoutes from './modules/requirements/requirements.routes.js';
import benefitsRoutes from './modules/benefits/benefits.routes.js';
import settingsRoutes from './modules/settings/settings.routes.js';
import membershipsRoutes from './modules/memberships/memberships.routes.js';
import subscriptionPlansRoutes from './modules/subscription-plans/subscription-plans.routes.js';
import paymentMethodsRoutes from './modules/payment-methods/payment-methods.routes.js';
import driversRoutes from './modules/drivers/drivers.routes.js';
import auditLogsRoutes from './modules/audit-logs/audit-logs.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';
import documentsRoutes from './modules/documents/documents.routes.js';
import billingRoutes from './modules/billing/billing.routes.js';
import trainingsRoutes from './modules/trainings/trainings.routes.js';

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
    // Per-request logs are noise in the console; errors still get logged
    logController: new LogController({ disableRequestLogging: true }),
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
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  });
  await app.register(dbPlugin);
  await app.register(authPlugin);
  await app.register(storagePlugin);
  await app.register(subscriptionScheduler);
  await app.register(documentScheduler);
  await app.register(debtScheduler);

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
      await api.register(paymentMethodsRoutes, { prefix: '/payment-methods' });
      await api.register(driversRoutes, { prefix: '/drivers' });
      await api.register(auditLogsRoutes, { prefix: '/audit-logs' });
      await api.register(dashboardRoutes, { prefix: '/dashboard' });
      await api.register(documentsRoutes, { prefix: '/documents' });
      await api.register(billingRoutes); // exposes /invoices and /payments
      await api.register(trainingsRoutes, { prefix: '/trainings' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
