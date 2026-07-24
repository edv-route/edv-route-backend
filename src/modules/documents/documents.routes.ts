import type { FastifyPluginAsync } from 'fastify';
import { SettingsRepository } from '../settings/settings.repository.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocumentsService } from './documents.service.js';

interface ListQuery {
  status?: 'valid' | 'expired' | 'rejected';
  requirementId?: number;
  search?: string;
  expiringDays?: number;
  page?: number;
  limit?: number;
}

const documentIdParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const documentsRoutes: FastifyPluginAsync = async (app) => {
  const service = new DocumentsService(
    app,
    new DocumentsRepository(app.db),
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
            status: { type: 'string', enum: ['valid', 'expired', 'rejected'] },
            requirementId: { type: 'integer', minimum: 1 },
            search: { type: 'string', maxLength: 100 },
            expiringDays: { type: 'integer', minimum: 1, maximum: 365 },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req) =>
      service.list({
        ...(req.query.status !== undefined ? { status: req.query.status } : {}),
        ...(req.query.requirementId !== undefined ? { requirementId: req.query.requirementId } : {}),
        ...(req.query.search !== undefined ? { search: req.query.search } : {}),
        ...(req.query.expiringDays !== undefined ? { expiringDays: req.query.expiringDays } : {}),
        page: req.query.page ?? 1,
        limit: req.query.limit ?? 20,
      }),
  );

  /** Upload: multipart, single file. Content is validated server-side. */
  app.post<{ Params: { id: string } }>(
    '/:id/file',
    { schema: { params: documentIdParam } },
    async (req, reply) => {
      const file = await req.file();
      if (!file) throw app.httpErrors.badRequest('No se recibió ningún archivo');

      const buffer = await file.toBuffer().catch(() => {
        throw app.httpErrors.badRequest('El archivo supera el máximo de 10 MB');
      });
      const result = await service.attachFile(
        req.params.id,
        { buffer, mimeType: file.mimetype },
        req.user.sub,
      );
      return reply.code(201).send(result);
    },
  );

  app.get<{ Params: { id: string } }>('/:id/file', { schema: { params: documentIdParam } }, async (req) =>
    service.getFileUrl(req.params.id),
  );
};

export default documentsRoutes;
