import type { FastifyPluginAsync } from 'fastify';
import { VehicleImagesRepository } from './vehicle-images.repository.js';
import { VehicleImagesService } from './vehicle-images.service.js';

const vehicleParams = {
  type: 'object',
  required: ['id', 'vehicleId'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    vehicleId: { type: 'string', format: 'uuid' },
  },
} as const;

const imageParams = {
  type: 'object',
  required: ['id', 'vehicleId', 'imageId'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    vehicleId: { type: 'string', format: 'uuid' },
    imageId: { type: 'string', format: 'uuid' },
  },
} as const;

/** Vehicle photos: mounted under /drivers, scoped by driver + vehicle. */
const vehicleImagesRoutes: FastifyPluginAsync = async (app) => {
  const service = new VehicleImagesService(app, new VehicleImagesRepository(app.db));

  app.addHook('onRequest', app.authenticate);

  /** Upload a photo (multipart, single file). Content validated server-side; 409 when full. */
  app.post<{ Params: { id: string; vehicleId: string } }>(
    '/:id/vehicles/:vehicleId/images',
    { schema: { params: vehicleParams } },
    async (req, reply) => {
      const file = await req.file();
      if (!file) throw app.httpErrors.badRequest('No se recibió ninguna imagen');
      const buffer = await file.toBuffer().catch(() => {
        throw app.httpErrors.badRequest('La imagen supera el máximo de 10 MB');
      });
      const result = await service.add(
        req.params.id,
        req.params.vehicleId,
        { buffer, mimeType: file.mimetype },
        req.user.sub,
      );
      return reply.code(201).send(result);
    },
  );

  app.get<{ Params: { id: string; vehicleId: string; imageId: string } }>(
    '/:id/vehicles/:vehicleId/images/:imageId/file',
    { schema: { params: imageParams } },
    async (req) => service.getFileUrl(req.params.id, req.params.vehicleId, req.params.imageId),
  );

  app.delete<{ Params: { id: string; vehicleId: string; imageId: string } }>(
    '/:id/vehicles/:vehicleId/images/:imageId',
    { schema: { params: imageParams } },
    async (req, reply) => {
      await service.remove(req.params.id, req.params.vehicleId, req.params.imageId, req.user.sub);
      return reply.code(204).send();
    },
  );
};

export default vehicleImagesRoutes;
