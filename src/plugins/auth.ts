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
/** Passenger session (mobile app, "Modo pasajero"). */
export interface ClientTokenPayload {
  sub: string;
  type: 'client';
}

export interface PasswordResetTokenPayload {
  sub: string;
  type: 'pwd_reset';
  rid: string;
}

/** Every token this API issues. `type` discriminates the audience. */
export type AppTokenPayload =
  | AdminTokenPayload
  | DriverTokenPayload
  | ClientTokenPayload
  | PasswordResetTokenPayload;

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
    /**
     * Guard for driver (mobile app) routes: valid token, audience === 'driver',
     * AND an account that has not been thrown out. See below for why the last
     * one costs a query.
     */
    authenticateDriver: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Guard for client (passenger) routes: valid token, audience === 'client',
     * AND an account that is not suspended. Same reasoning as the driver one.
     */
    authenticateClient: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Statuses that lose access to the app entirely. Deliberately just the one.
 *
 * A driver in debt - `penalized` included - KEEPS getting in (decision
 * 2026-08-18): the app is the only screen where he can see and pay what he
 * owes, so locking him out would leave him penalized with no way out. What he
 * loses is the WORK, and that is enforced per function (`CAN_OPERATE_STATUSES`),
 * never at the door.
 *
 * `rejected` also gets in, for the same reason: he has to be able to read WHY
 * he was rejected, and an admin may reopen his solicitud. A door with no way
 * out is a bug this project has already shipped three times.
 *
 * `suspended` is the expulsion, and that one is final.
 */
const LOCKED_OUT_STATUSES = new Set(['suspended']);

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
      // Default lifetime; the driver login overrides it with the much longer
      // DRIVER_JWT_EXPIRES_IN when it signs.
      sign: { expiresIn: app.config.JWT_EXPIRES_IN },
    });

    const verifyAudience =
      (audience: AppTokenPayload['type']) =>
      async (req: FastifyRequest): Promise<void> => {
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
    app.decorate('authenticate', verifyAudience('admin'));

    const driverAudience = verifyAudience('driver');

    /**
     * The driver session is long-lived (a year by default) so the app survives
     * being closed for days and location reporting does not die every night.
     * A JWT that long CANNOT be revoked by letting it expire, so this guard
     * asks the database on every request whether the account still exists and
     * is not expelled.
     *
     * That is one extra round trip per request, and it buys the only thing that
     * can cut somebody off: suspending a driver from the panel stops him — and
     * his phone's location reporting — within seconds, instead of leaving a
     * stolen or handed-down phone reporting for months.
     *
     * Cheap by design: one indexed lookup by primary key, on a fleet of tens.
     * Caching it would trade away the immediacy that is the whole point.
     */
    app.decorate('authenticateDriver', async (req: FastifyRequest, _reply: FastifyReply) => {
      await driverAudience(req);

      const { rows } = await app.db.query<{ driverStatus: string; userStatus: string }>(
        `SELECT d.status::text AS "driverStatus", u.status::text AS "userStatus"
           FROM drivers d JOIN users u ON u.id = d.user_id
          WHERE d.user_id = $1`,
        [req.user.sub],
      );

      const account = rows[0];
      // Gone entirely: the applicant cleanup deletes abandoned registrations,
      // and a token outliving its account must not keep working.
      if (!account) {
        throw app.httpErrors.unauthorized('Tu cuenta ya no existe');
      }
      if (LOCKED_OUT_STATUSES.has(account.driverStatus) || account.userStatus === 'suspended') {
        // 403, not 401: the session is valid, the account is not. The app tells
        // them apart to decide between "log in again" and "you were suspended".
        throw app.httpErrors.forbidden('Tu cuenta fue suspendida. Comunícate con la oficina.');
      }
    });

    const clientAudience = verifyAudience('client');

    /**
     * Same shape as the driver guard, and for the same reason: the passenger
     * session is long-lived, so expiry cannot revoke it. Asking the database
     * on every request is what makes suspending somebody take effect at once.
     *
     * It checks BOTH sides: `clients.status` for a passenger the office
     * stopped, and `users.status` for a person suspended altogether — which
     * matters because that same row may also be an affiliate.
     */
    app.decorate('authenticateClient', async (req: FastifyRequest, _reply: FastifyReply) => {
      await clientAudience(req);

      const { rows } = await app.db.query<{ clientStatus: string; userStatus: string }>(
        `SELECT c.status AS "clientStatus", u.status::text AS "userStatus"
           FROM clients c JOIN users u ON u.id = c.user_id
          WHERE c.user_id = $1`,
        [req.user.sub],
      );

      const account = rows[0];
      if (!account) {
        throw app.httpErrors.unauthorized('Tu cuenta ya no existe');
      }
      if (account.clientStatus === 'suspended' || account.userStatus === 'suspended') {
        // 403, not 401: the session is valid, the account is not.
        throw app.httpErrors.forbidden('Tu cuenta fue suspendida. Comunícate con la oficina.');
      }
    });
  },
  { name: 'auth', dependencies: ['db'] },
);
