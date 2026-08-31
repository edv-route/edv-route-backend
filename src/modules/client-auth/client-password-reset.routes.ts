import type { FastifyPluginAsync } from 'fastify';
import { PasswordResetRepository } from '../driver-auth/password-reset.repository.js';
import { PasswordResetService } from '../driver-auth/password-reset.service.js';

/**
 * "Olvidé mi clave" for the passenger (fase C-d of docs/proposals/cliente).
 *
 * Same three public steps as the driver's, run by the SAME service — imported,
 * not copied, the way this module already imports `personProperties`. What
 * differs is deliberate and small: the identity is the email alone (a
 * passenger has no cédula on file, and the email is both his identifier and
 * where the code lands), and the confirmation mail words "entrar" his way.
 *
 * Mounted under `/client-auth`, so the paths mirror the driver's:
 *   /client-auth/password-reset/request | verify | confirm
 */

const email = { type: 'string', format: 'email', minLength: 5, maxLength: 120 } as const;

const requestSchema = {
  body: {
    type: 'object',
    required: ['email'],
    additionalProperties: false,
    properties: { email },
  },
} as const;

const verifySchema = {
  body: {
    type: 'object',
    required: ['email', 'code'],
    additionalProperties: false,
    properties: {
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
      // Same policy as the rest of the system: min 6, digits-only allowed.
      password: { type: 'string', minLength: 6, maxLength: 72 },
    },
  },
} as const;

const clientPasswordResetRoutes: FastifyPluginAsync = async (app) => {
  const service = new PasswordResetService(app, new PasswordResetRepository(app.db));

  app.post<{ Body: { email: string } }>(
    '/password-reset/request',
    { schema: requestSchema },
    async (req, reply) => {
      await service.requestClientCode({ email: req.body.email, ip: req.ip ?? null });
      return reply.code(204).send();
    },
  );

  app.post<{ Body: { email: string; code: string } }>(
    '/password-reset/verify',
    { schema: verifySchema },
    async (req) => service.verifyClientCode(req.body),
  );

  app.post<{ Body: { resetToken: string; password: string } }>(
    '/password-reset/confirm',
    { schema: confirmSchema },
    async (req, reply) => {
      await service.confirm(req.body, 'client');
      return reply.code(204).send();
    },
  );
};

export default clientPasswordResetRoutes;
