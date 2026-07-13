import type { FastifyPluginAsync } from 'fastify';
import { writeAudit } from '../audit-logs/audit-writer.js';
import { SettingsRepository } from './settings.repository.js';

const settingSchema = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    value: {},
    description: { type: ['string', 'null'] },
    updatedBy: { type: ['string', 'null'] },
    updatedAt: { type: 'string' },
  },
} as const;

const settingsRoutes: FastifyPluginAsync = async (app) => {
  const settings = new SettingsRepository(app.db);

  app.addHook('onRequest', app.authenticate);

  app.get(
    '/',
    { schema: { response: { 200: { type: 'array', items: settingSchema } } } },
    async () => settings.list(),
  );

  app.patch<{ Params: { key: string }; Body: { value: unknown } }>(
    '/:key',
    {
      schema: {
        params: {
          type: 'object',
          required: ['key'],
          properties: { key: { type: 'string', minLength: 1, maxLength: 100 } },
        },
        body: {
          type: 'object',
          required: ['value'],
          additionalProperties: false,
          properties: { value: {} },
        },
        response: { 200: settingSchema },
      },
    },
    async (req) => {
      const record = await settings.update(req.params.key, req.body.value, req.user.sub);
      if (!record) throw app.httpErrors.notFound('Configuración no encontrada');
      await writeAudit(app.db, {
        actorAdminId: req.user.sub,
        eventType: 'setting.updated',
        entity: 'app_settings',
        entityId: req.params.key,
        data: { value: req.body.value },
      });
      return record;
    },
  );
};

export default settingsRoutes;
