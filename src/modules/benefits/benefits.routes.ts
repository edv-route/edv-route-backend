import type { FastifyPluginAsync } from 'fastify';
import { BenefitsRepository } from './benefits.repository.js';
import { BenefitsService } from './benefits.service.js';
import {
  createBenefitSchema,
  deleteBenefitSchema,
  listBenefitsSchema,
  updateBenefitSchema,
} from './benefits.schemas.js';

const benefitsRoutes: FastifyPluginAsync = async (app) => {
  const service = new BenefitsService(app, new BenefitsRepository(app.db));

  app.addHook('onRequest', app.authenticate);

  app.get('/', { schema: listBenefitsSchema }, async () => service.list());

  app.post<{ Body: { name: string; description?: string | null } }>(
    '/',
    { schema: createBenefitSchema },
    async (req, reply) => {
      const record = await service.create(req.body.name, req.body.description ?? null, req.user.sub);
      return reply.code(201).send(record);
    },
  );

  app.patch<{
    Params: { id: number };
    Body: { name?: string; description?: string | null; active?: boolean };
  }>('/:id', { schema: updateBenefitSchema }, async (req) =>
    service.update(req.params.id, req.body, req.user.sub),
  );

  app.delete<{ Params: { id: number } }>(
    '/:id',
    { schema: deleteBenefitSchema },
    async (req, reply) => {
      await service.delete(req.params.id, req.user.sub);
      return reply.code(204).send();
    },
  );
};

export default benefitsRoutes;
