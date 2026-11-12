import type { FastifyPluginAsync } from 'fastify';
import type { IdentityPhotoKind } from './identity.repository.js';
import { IdentityRepository } from './identity.repository.js';
import { identityViewSchema, kindParamSchema } from './identity.schemas.js';
import { IdentityService } from './identity.service.js';

export interface IdentityAppRoutesOptions {
  /** Which app is calling: decides the session guard, nothing else. */
  channel: 'driver' | 'client';
}

/**
 * The person's own identity photos, from the app. Mounted twice — under
 * `/driver-auth` and `/client-auth` — because the photos belong to the PERSON:
 * the same three photos serve both roles, and whoever already sent them in one
 * role is not asked again in the other.
 */
const identityAppRoutes: FastifyPluginAsync<IdentityAppRoutesOptions> = async (app, opts) => {
  const service = new IdentityService(app, new IdentityRepository(app.db));
  const guard = opts.channel === 'driver' ? app.authenticateDriver : app.authenticateClient;

  app.get(
    '/me/identity',
    { onRequest: [guard], schema: { response: { 200: identityViewSchema } } },
    async (req) => service.getOwn(req.user.sub),
  );

  // Multipart, one photo per call: the app sends them as they are taken, so a
  // failed upload costs one photo, not three.
  app.post<{ Params: { kind: IdentityPhotoKind } }>(
    '/me/identity/:kind',
    { onRequest: [guard], schema: { params: kindParamSchema, response: { 200: identityViewSchema } } },
    async (req) => {
      const file = await req.file();
      if (!file) throw app.httpErrors.badRequest('No se recibió ninguna foto');
      const buffer = await file.toBuffer().catch(() => {
        throw app.httpErrors.badRequest('La foto supera el máximo de 10 MB');
      });
      return service.upload(req.user.sub, req.params.kind, { buffer });
    },
  );
};

export default identityAppRoutes;
