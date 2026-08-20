import type { FastifyPluginAsync } from 'fastify';
import { NotificationsRepository } from './notifications.repository.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
    /** Keyset cursor: the `nextCursor` of the previous page. */
    before: { type: 'string', pattern: '^[0-9]+$' },
  },
} as const;

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[0-9]+$' } },
} as const;

/**
 * Every field is declared: Fastify serializes against the schema and DROPS
 * anything missing, silently. That has already cost this project two bugs
 * (`rejected` and `tariffStartsAt`).
 */
const listSchema = {
  querystring: listQuery,
  response: {
    200: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              title: { type: 'string' },
              body: { type: 'string' },
              payload: { type: ['object', 'null'] },
              createdAt: { type: 'string' },
              readAt: { type: ['string', 'null'] },
            },
          },
        },
        nextCursor: { type: ['string', 'null'] },
        unread: { type: 'integer' },
      },
    },
  },
} as const;

/**
 * The affiliate's inbox (app channel). Registered under `/driver-auth` instead
 * of living inside `driver-auth.routes.ts`: it is its own responsibility and
 * that file is already carrying the whole app channel.
 *
 * The inbox is NOT optional decoration around push. A push is swiped away and
 * gone, and there are drivers who will never receive one at all (Huawei without
 * Play Services since 2019, permission denied on Android 13+). For them this is
 * the only channel there is.
 */
const notificationsRoutes: FastifyPluginAsync = async (app) => {
  const notifications = new NotificationsRepository(app.db);

  app.get<{ Querystring: { limit?: number; before?: string } }>(
    '/me/notifications',
    { onRequest: [app.authenticateDriver], schema: listSchema },
    async (req) =>
      notifications.listForDriver(req.user.sub, {
        limit: req.query.limit ?? DEFAULT_LIMIT,
        before: req.query.before,
      }),
  );

  // Idempotent by design: opening the same notice twice, or two devices marking
  // it at once, must not be an error the app has to handle. Always 204.
  app.post<{ Params: { id: string } }>(
    '/me/notifications/:id/read',
    { onRequest: [app.authenticateDriver], schema: { params: idParam } },
    async (req, reply) => {
      await notifications.markRead(req.user.sub, req.params.id);
      return reply.code(204).send();
    },
  );

  app.post(
    '/me/notifications/read-all',
    { onRequest: [app.authenticateDriver] },
    async (req) => ({ marked: await notifications.markAllRead(req.user.sub) }),
  );
};

export default notificationsRoutes;
