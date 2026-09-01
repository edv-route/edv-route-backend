import type { FastifyPluginAsync } from 'fastify';
import { PasswordResetRepository } from './password-reset.repository.js';
import { PasswordResetService } from './password-reset.service.js';

/**
 * "Olvidé mi clave" for the driver app (2026-08-24). Three PUBLIC steps - the
 * whole point is that the driver cannot log in - each one narrow on purpose:
 *
 *   request -> cédula + email must match ONE account; a 6-digit code is mailed
 *   verify  -> the code, 3 tries, mints a single-purpose token
 *   confirm -> the token plus the new password
 *
 * They live in their own file rather than inside `driver-auth.routes.ts` (445
 * lines already) and mount under the same `/driver-auth` prefix, the way the
 * notification routes do.
 */

// Canonical form written by the system, same pattern the rest of the API uses.
const nationalId = { type: 'string', pattern: '^[VEJ]-\\d{5,9}$' } as const;
const email = { type: 'string', format: 'email', minLength: 5, maxLength: 120 } as const;

const requestSchema = {
  body: {
    type: 'object',
    required: ['nationalId', 'email'],
    additionalProperties: false,
    properties: { nationalId, email },
  },
} as const;

const verifySchema = {
  body: {
    type: 'object',
    required: ['nationalId', 'email', 'code'],
    additionalProperties: false,
    properties: {
      nationalId,
      email,
      // Exactly six digits: anything else is a typo, not a wrong code, and it
      // should not spend one of his three tries.
      code: { type: 'string', pattern: '^\\d{6}$' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: { resetToken: { type: 'string' } },
    },
  },
} as const;

const confirmSchema = {
  body: {
    type: 'object',
    required: ['resetToken', 'password'],
    additionalProperties: false,
    properties: {
      resetToken: { type: 'string', maxLength: 2000 },
      // Numeric 6-8 (decision by Luis, 2026-09-01): the NEW password follows
      // the app policy; old passwords keep working at login until changed.
      password: { type: 'string', pattern: '^\\d{6,8}$' },
    },
  },
} as const;

const passwordResetRoutes: FastifyPluginAsync = async (app) => {
  const service = new PasswordResetService(app, new PasswordResetRepository(app.db));

  app.post<{ Body: { nationalId: string; email: string } }>(
    '/password-reset/request',
    { schema: requestSchema },
    async (req, reply) => {
      await service.requestCode({
        nationalId: req.body.nationalId,
        email: req.body.email,
        ip: req.ip ?? null,
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Body: { nationalId: string; email: string; code: string } }>(
    '/password-reset/verify',
    { schema: verifySchema },
    async (req) => service.verifyCode(req.body),
  );

  app.post<{ Body: { resetToken: string; password: string } }>(
    '/password-reset/confirm',
    { schema: confirmSchema },
    async (req, reply) => {
      await service.confirm(req.body);
      return reply.code(204).send();
    },
  );
};

export default passwordResetRoutes;
