import type { FastifyPluginAsync } from 'fastify';
import { VehicleTypesRepository } from './vehicle-types.repository.js';
import { VehicleTypesService } from './vehicle-types.service.js';
import {
  createVehicleTypeSchema,
  deleteVehicleTypeSchema,
  listVehicleTypesSchema,
  updateVehicleTypeSchema,
} from './vehicle-types.schemas.js';

const vehicleTypesRoutes: FastifyPluginAsync = async (app) => {
  const service = new VehicleTypesService(app, new VehicleTypesRepository(app.db));

  app.addHook('onRequest', app.authenticate);

  app.get('/', { schema: listVehicleTypesSchema }, async () => service.list());

  app.post<{ Body: { name: string } }>(
    '/',
    { schema: createVehicleTypeSchema },
    async (req, reply) => {
      const record = await service.create(req.body.name, req.user.sub);
      return reply.code(201).send(record);
    },
  );

  app.patch<{ Params: { id: number }; Body: { name?: string; active?: boolean } }>(
    '/:id',
    { schema: updateVehicleTypeSchema },
    async (req) => service.update(req.params.id, req.body, req.user.sub),
  );

  app.delete<{ Params: { id: number } }>(
    '/:id',
    { schema: deleteVehicleTypeSchema },
    async (req, reply) => {
      await service.delete(req.params.id, req.user.sub);
      return reply.code(204).send();
    },
  );
};

export default vehicleTypesRoutes;
