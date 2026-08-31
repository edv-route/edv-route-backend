import type { FastifyPluginAsync } from 'fastify';
import { ClientAuthRepository } from './client-auth.repository.js';
import { ClientAuthService, type ClientRegisterInput } from './client-auth.service.js';
import {
  clientLoginSchema,
  clientPhotoSchema,
  clientProfileSchema,
  clientRegisterSchema,
  clientUpdateSchema,
} from './client-auth.schemas.js';

/**
 * The passenger's own channel (proposal: docs/proposals/cliente).
 *
 * Mounted under `/client-auth`, mirroring `/driver-auth`. Registration and
 * login are the only public routes — everything else needs the client token,
 * and the guard checks the audience, because all three token types are signed
 * with the same secret and a client must never open a driver's endpoint.
 */
const clientAuthRoutes: FastifyPluginAsync = async (app) => {
  const service = new ClientAuthService(app, new ClientAuthRepository(app.db));

  app.post<{ Body: { identifier: string; password: string } }>(
    '/login',
    { schema: clientLoginSchema },
    async (req) => service.login(req.body.identifier, req.body.password),
  );

  app.post<{ Body: ClientRegisterInput }>(
    '/register',
    { schema: clientRegisterSchema },
    async (req, reply) => {
      const result = await service.register(req.body);
      return reply.code(201).send(result);
    },
  );

  app.get(
    '/me',
    { onRequest: [app.authenticateClient], schema: clientProfileSchema },
    async (req) => service.getProfile(req.user.sub),
  );

  app.patch<{ Body: Partial<ClientRegisterInput> & { currentPassword?: string } }>(
    '/me',
    { onRequest: [app.authenticateClient], schema: clientUpdateSchema },
    async (req) => service.updateProfile(req.user.sub, req.body),
  );

  app.post(
    '/me/photo',
    { onRequest: [app.authenticateClient], schema: clientPhotoSchema },
    async (req) => {
      const file = await req.file();
      if (!file) throw app.httpErrors.badRequest('No se recibió ninguna imagen');
      const buffer = await file.toBuffer().catch(() => {
        throw app.httpErrors.badRequest('La imagen supera el máximo de 10 MB');
      });
      return service.replacePhoto(req.user.sub, { buffer, mimeType: file.mimetype });
    },
  );
};

export default clientAuthRoutes;
