import type { FastifyPluginAsync } from 'fastify';
import { IdentityRepository } from './identity.repository.js';
import {
  identityViewSchema,
  photoIdParamSchema,
  rejectBodySchema,
  userIdParamSchema,
} from './identity.schemas.js';
import { IdentityService } from './identity.service.js';

/**
 * The office's side: see a person's identity photos (affiliate or passenger,
 * it is the same person record) and approve or reject each one.
 */
const identityAdminRoutes: FastifyPluginAsync = async (app) => {
  const service = new IdentityService(app, new IdentityRepository(app.db));

  app.addHook('onRequest', app.authenticate);

  app.get<{ Params: { userId: string } }>(
    '/users/:userId',
    { schema: { params: userIdParamSchema, response: { 200: identityViewSchema } } },
    async (req) => service.getForAdmin(req.params.userId),
  );

  app.post<{ Params: { photoId: string } }>(
    '/photos/:photoId/approve',
    { schema: { params: photoIdParamSchema, response: { 200: identityViewSchema } } },
    async (req) => service.review(req.params.photoId, true, null, req.user.sub),
  );

  // Also the passenger's "pedir otra foto": rejecting an approved photo revokes it.
  app.post<{ Params: { photoId: string }; Body: { reason: string } }>(
    '/photos/:photoId/reject',
    {
      schema: {
        params: photoIdParamSchema,
        body: rejectBodySchema,
        response: { 200: identityViewSchema },
      },
    },
    async (req) => service.review(req.params.photoId, false, req.body.reason, req.user.sub),
  );
};

export default identityAdminRoutes;
