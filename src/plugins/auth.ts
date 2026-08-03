import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Admin (panel) session token. */
export interface AdminTokenPayload {
  sub: string;
  type: 'admin';
  username: string;
  role: string;
}

/** Driver (mobile app) session token. */
export interface DriverTokenPayload {
  sub: string;
  type: 'driver';
}

/** Every token this API issues. `type` discriminates the audience. */
export type AppTokenPayload = AdminTokenPayload | DriverTokenPayload;

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AppTokenPayload;
    user: AppTokenPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Guard for admin (panel) routes: valid token AND audience === 'admin'. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Guard for driver (mobile app) routes: valid token AND audience === 'driver'. */
    authenticateDriver: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * JWT signing/verification plus the audience-scoped guards used as onRequest
 * hooks by the modules. The `type` claim keeps a driver token from reaching
 * admin routes and vice versa (a plain signature check is not enough — both
 * audiences are signed with the same secret).
 */
export default fp(
  async (app) => {
    await app.register(jwt, {
      secret: app.config.JWT_SECRET,
      sign: { expiresIn: app.config.JWT_EXPIRES_IN },
    });

    const guard =
      (audience: AppTokenPayload['type']) =>
      async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        try {
          await req.jwtVerify();
        } catch {
          throw app.httpErrors.unauthorized('Sesión inválida o expirada');
        }
        if (req.user.type !== audience) {
          throw app.httpErrors.forbidden('No autorizado para este recurso');
        }
      };

    app.decorate('authenticate', guard('admin'));
    app.decorate('authenticateDriver', guard('driver'));
  },
  { name: 'auth' },
);
