import type { FastifyPluginAsync } from 'fastify';
import { EnrollmentRepository } from '../drivers/enrollment.repository.js';
import { PaymentSubmissionsRepository } from './payment-submissions.repository.js';
import { PaymentSubmissionsService, type UploadedFile } from './payment-submissions.service.js';

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

interface ListQuery {
  status?: 'pending' | 'approved' | 'rejected';
  driverId?: string;
  page?: number;
  limit?: number;
}

/**
 * Payment submissions (v9): the reviewable money-in flow. Creation is multipart
 * (payment meta + 1..5 receipt/bill images); review (list/detail/approve/reject)
 * is JSON. Registered without a prefix so it can own both
 * `/drivers/:id/payment-submissions` and `/payment-submissions/...`.
 */
const paymentSubmissionsRoutes: FastifyPluginAsync = async (app) => {
  const enrollment = new EnrollmentRepository(app.db);
  const repo = new PaymentSubmissionsRepository(app.db, enrollment);
  const service = new PaymentSubmissionsService(app, repo);

  app.addHook('onRequest', app.authenticate);

  // Create a submission (admin registers a payment on the driver's behalf).
  app.post<{ Params: { id: string } }>(
    '/drivers/:id/payment-submissions',
    { schema: { params: idParam } },
    async (req, reply) => {
      const fields: Record<string, string> = {};
      const files: UploadedFile[] = [];
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const buffer = await part.toBuffer().catch(() => {
            throw app.httpErrors.badRequest('Un archivo supera el máximo de 10 MB');
          });
          files.push({ buffer, mimeType: part.mimetype });
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
      const result = await service.create(
        req.params.id,
        {
          paymentMethodId: fields['paymentMethodId'] ? Number(fields['paymentMethodId']) : null,
          reference: fields['reference'] ?? null,
          payerBank: fields['payerBank'] ?? null,
          paidOn: fields['paidOn'] ?? null,
          payerPhone: fields['payerPhone'] ?? null,
          payerId: fields['payerId'] ?? null,
          payerAccount: fields['payerAccount'] ?? null,
          note: fields['note'] ?? null,
          amountUsd: fields['amountUsd'] ?? null,
          purpose:
            fields['purpose'] === 'advance'
              ? 'advance'
              : fields['purpose'] === 'enroll'
                ? 'enroll'
                : fields['purpose'] === 'change_plan'
                  ? 'change_plan'
                  : 'debt',
          periods: fields['periods'] ? Number(fields['periods']) : null,
          planId: fields['planId'] ? Number(fields['planId']) : null,
          source: 'admin',
          submittedBy: req.user.sub,
        },
        files,
        req.user.sub,
      );
      return reply.code(201).send(result);
    },
  );

  // Review inbox (defaults to pending first via the repository ordering).
  app.get<{ Querystring: ListQuery }>(
    '/payment-submissions',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
            driverId: { type: 'string', format: 'uuid' },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req) =>
      service.list({
        ...(req.query.status !== undefined ? { status: req.query.status } : {}),
        ...(req.query.driverId !== undefined ? { driverId: req.query.driverId } : {}),
        page: req.query.page ?? 1,
        limit: req.query.limit ?? 20,
      }),
  );

  app.get<{ Params: { id: string } }>(
    '/payment-submissions/:id',
    { schema: { params: idParam } },
    async (req) => service.detail(req.params.id),
  );

  app.post<{ Params: { id: string } }>(
    '/payment-submissions/:id/approve',
    { schema: { params: idParam } },
    async (req) => service.approve(req.params.id, req.user.sub),
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/payment-submissions/:id/reject',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (req, reply) => {
      await service.reject(req.params.id, req.body.reason, req.user.sub);
      return reply.code(204).send();
    },
  );
};

export default paymentSubmissionsRoutes;
