import type { FastifyPluginAsync } from 'fastify';
import { SettingsRepository } from '../settings/settings.repository.js';
import { AuditLogsRepository } from './audit-logs.repository.js';
import { AuditLogsService } from './audit-logs.service.js';

interface ListQuery {
  entity?: string;
  eventType?: string;
  source?: 'admin' | 'system';
  adminId?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

const auditLogsRoutes: FastifyPluginAsync = async (app) => {
  const service = new AuditLogsService(
    new AuditLogsRepository(app.db),
    new SettingsRepository(app.db),
  );

  app.addHook('onRequest', app.authenticate);

  app.get<{ Querystring: ListQuery }>(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entity: { type: 'string', maxLength: 60 },
            eventType: { type: 'string', maxLength: 60 },
            source: { type: 'string', enum: ['admin', 'system'] },
            adminId: { type: 'string', format: 'uuid' },
            from: { type: 'string', format: 'date' },
            to: { type: 'string', format: 'date' },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req) =>
      service.list({
        ...(req.query.entity !== undefined ? { entity: req.query.entity } : {}),
        ...(req.query.eventType !== undefined ? { eventType: req.query.eventType } : {}),
        ...(req.query.source !== undefined ? { source: req.query.source } : {}),
        ...(req.query.adminId !== undefined ? { adminId: req.query.adminId } : {}),
        ...(req.query.from !== undefined ? { from: req.query.from } : {}),
        ...(req.query.to !== undefined ? { to: req.query.to } : {}),
        page: req.query.page ?? 1,
        limit: req.query.limit ?? 20,
      }),
  );

  app.get('/facets', async () => service.facets());
};

export default auditLogsRoutes;
