import type { FastifyPluginAsync } from 'fastify';
import { SettingsRepository } from '../settings/settings.repository.js';
import { BillingRepository } from './billing.repository.js';
import { BillingService } from './billing.service.js';

const invoiceIdParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

interface InvoicesQuery {
  status?: 'issued' | 'voided';
  driverId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

interface PaymentsQuery {
  kind?: 'membership' | 'subscription';
  status?: 'pending' | 'paid' | 'refunded';
  driverId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

const pagination = {
  page: { type: 'integer', minimum: 1, default: 1 },
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
} as const;

/**
 * Money histories are read-only by design: invoices and payments are
 * created/refunded exclusively through the enrollment and renewal flows
 * (money documents are never deleted, only voided/refunded with a trace).
 */
const billingRoutes: FastifyPluginAsync = async (app) => {
  const billing = new BillingRepository(app.db);
  const settings = new SettingsRepository(app.db);
  const service = new BillingService(app, billing);

  app.addHook('onRequest', app.authenticate);

  app.get<{ Querystring: { months?: number } }>(
    '/invoices/monthly-series',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            months: { type: 'integer', minimum: 3, maximum: 24, default: 12 },
          },
        },
      },
    },
    async (req) => {
      const timezone = await settings.get('business_timezone', 'America/Caracas');
      return billing.monthlySeries(req.query.months ?? 12, String(timezone));
    },
  );

  app.get<{ Querystring: InvoicesQuery }>(
    '/invoices',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['issued', 'voided'] },
            driverId: { type: 'string', format: 'uuid' },
            search: { type: 'string', maxLength: 100 },
            ...pagination,
          },
        },
      },
    },
    async (req) =>
      billing.listInvoices({
        ...(req.query.status !== undefined ? { status: req.query.status } : {}),
        ...(req.query.driverId !== undefined ? { driverId: req.query.driverId } : {}),
        ...(req.query.search !== undefined ? { search: req.query.search } : {}),
        page: req.query.page ?? 1,
        limit: req.query.limit ?? 20,
      }),
  );

  app.get<{ Querystring: PaymentsQuery }>(
    '/payments',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['membership', 'subscription'] },
            status: { type: 'string', enum: ['pending', 'paid', 'refunded'] },
            driverId: { type: 'string', format: 'uuid' },
            search: { type: 'string', maxLength: 100 },
            ...pagination,
          },
        },
      },
    },
    async (req) =>
      billing.listPayments({
        ...(req.query.kind !== undefined ? { kind: req.query.kind } : {}),
        ...(req.query.status !== undefined ? { status: req.query.status } : {}),
        ...(req.query.driverId !== undefined ? { driverId: req.query.driverId } : {}),
        ...(req.query.search !== undefined ? { search: req.query.search } : {}),
        page: req.query.page ?? 1,
        limit: req.query.limit ?? 20,
      }),
  );

  // Payment receipt (comprobante): multipart upload + short-lived signed URL,
  // same custody as document files (private bucket, magic-number validation).
  app.post<{ Params: { id: string } }>(
    '/invoices/:id/proof',
    { schema: { params: invoiceIdParam } },
    async (req, reply) => {
      const file = await req.file();
      if (!file) throw app.httpErrors.badRequest('No se recibió ningún archivo');
      const buffer = await file.toBuffer().catch(() => {
        throw app.httpErrors.badRequest('El archivo supera el máximo de 10 MB');
      });
      const result = await service.attachProof(
        req.params.id,
        { buffer, mimeType: file.mimetype },
        req.user.sub,
      );
      return reply.code(201).send(result);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/invoices/:id/proof',
    { schema: { params: invoiceIdParam } },
    async (req) => service.getProofUrl(req.params.id),
  );
};

export default billingRoutes;
