import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface AdminTokenPayload {
  sub: string;
  username: string;
  role: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AdminTokenPayload;
    user: AdminTokenPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * JWT signing/verification plus the `authenticate` guard used as an
 * onRequest hook by every private module.
 */
export default fp(
  async (app) => {
    await app.register(jwt, {
      secret: app.config.JWT_SECRET,
      sign: { expiresIn: app.config.JWT_EXPIRES_IN },
    });

    app.decorate('authenticate', async (req: FastifyRequest, _reply: FastifyReply) => {
      try {
        await req.jwtVerify();
      } catch {
        throw app.httpErrors.unauthorized('Sesión inválida o expirada');
      }
    });
  },
  { name: 'auth' },
);
