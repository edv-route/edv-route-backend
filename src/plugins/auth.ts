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

/**
 * Minted when a recovery code is verified, and good for ONE thing: setting a
 * new password. It is not a session - the guards below reject it because its
 * `type` matches neither audience, which is the point: verifying a 6-digit
 * code must not hand out something that can read the driver's money.
 *
 * `rid` is the reset attempt it belongs to, so the row can veto a replay even
 * while the signature is still valid (a JWT cannot be revoked; the row can).
 */
export interface PasswordResetTokenPayload {
  sub: string;
  type: 'pwd_reset';
  rid: string;
}

/** Every token this API issues. `type` discriminates the audience. */
export type AppTokenPayload = AdminTokenPayload | DriverTokenPayload | PasswordResetTokenPayload;

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

    // Only the two session audiences get a guard. A 'pwd_reset' token is
    // verified by hand where it is redeemed, never as a session.
    app.decorate('authenticate', guard('admin'));
    app.decorate('authenticateDriver', guard('driver'));
  },
  { name: 'auth' },
);
