import type { FastifyPluginAsync } from 'fastify';
import { RequirementsRepository, type UpdateRequirementData } from './requirements.repository.js';
import { RequirementsService } from './requirements.service.js';
import {
  createRequirementSchema,
  deleteRequirementSchema,
  listRequirementsSchema,
  updateRequirementSchema,
} from './requirements.schemas.js';

interface CreateBody {
  name: string;
  description?: string | null;
  appliesTo: 'driver' | 'vehicle';
  isRequired?: boolean;
}

const requirementsRoutes: FastifyPluginAsync = async (app) => {
  const service = new RequirementsService(app, new RequirementsRepository(app.db));

  app.addHook('onRequest', app.authenticate);

  app.get('/', { schema: listRequirementsSchema }, async () => service.list());

  app.post<{ Body: CreateBody }>(
    '/',
    { schema: createRequirementSchema },
    async (req, reply) => {
      const record = await service.create({
        name: req.body.name,
        description: req.body.description ?? null,
        appliesTo: req.body.appliesTo,
        isRequired: req.body.isRequired ?? false,
        createdBy: req.user.sub,
      });
      return reply.code(201).send(record);
    },
  );

  app.patch<{ Params: { id: number }; Body: UpdateRequirementData }>(
    '/:id',
    { schema: updateRequirementSchema },
    async (req) => service.update(req.params.id, req.body),
  );

  app.delete<{ Params: { id: number } }>(
    '/:id',
    { schema: deleteRequirementSchema },
    async (req, reply) => {
      await service.delete(req.params.id);
      return reply.code(204).send();
    },
  );
};

export default requirementsRoutes;
