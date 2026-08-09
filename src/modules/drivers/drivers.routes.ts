import type { FastifyPluginAsync } from 'fastify';
import { DriversRepository } from './drivers.repository.js';
import { EnrollmentRepository } from './enrollment.repository.js';
import {
  DriversService,
  type CreateDriverInput,
  type DocumentInput,
  type EnrollInput,
  type PaymentMeta,
  type RegisterDocumentInput,
  type RegisterVehicleInput,
  type VehicleInput,
} from './drivers.service.js';
import {
  createBody,
  paymentMetaProps,
  personProperties,
  registerBody,
  vehicleFieldProps,
} from './drivers.schemas.js';

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const driversRoutes: FastifyPluginAsync = async (app) => {
  const service = new DriversService(
    app,
    new DriversRepository(app.db),
    new EnrollmentRepository(app.db),
  );

  app.addHook('onRequest', app.authenticate);

  app.get<{ Querystring: { status?: string; search?: string; page?: number; limit?: number } }>(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: {
              type: 'string',
              enum: ['pending', 'scheduled', 'approved', 'rejected', 'suspended', 'paused', 'overdue', 'penalized'],
            },
            search: { type: 'string', maxLength: 100 },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req) =>
      service.list({
        ...(req.query.status !== undefined ? { status: req.query.status } : {}),
        ...(req.query.search !== undefined ? { search: req.query.search } : {}),
        page: req.query.page ?? 1,
        limit: req.query.limit ?? 20,
      }),
  );

  app.get<{ Params: { id: string } }>('/:id', { schema: { params: idParam } }, async (req) =>
    service.getDetail(req.params.id),
  );

  app.post<{ Body: CreateDriverInput }>(
    '/',
    { schema: { body: createBody } },
    async (req, reply) => {
      const detail = await service.create(req.body, req.user.sub);
      return reply.code(201).send(detail);
    },
  );

  app.post<{
    Body: CreateDriverInput & {
      payment?: EnrollInput | null;
      vehicles?: RegisterVehicleInput[];
      documents?: RegisterDocumentInput[];
      deferredEnrollment?: boolean;
    };
  }>(
    '/register',
    { schema: { body: registerBody } },
    async (req, reply) => {
      const { payment, vehicles, documents, deferredEnrollment, ...person } = req.body;
      const detail = await service.register(
        person,
        {
          payment: payment ?? null,
          vehicles: vehicles ?? [],
          documents: documents ?? [],
          deferredEnrollment: deferredEnrollment ?? false,
        },
        req.user.sub,
      );
      return reply.code(201).send(detail);
    },
  );

  app.patch<{
    Params: { id: string };
    Body: Partial<CreateDriverInput> & { status?: 'approved' | 'suspended' };
  }>(
    '/:id',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            ...personProperties,
            status: { type: 'string', enum: ['approved', 'suspended'] },
          },
        },
      },
    },
    async (req) => service.updateProfile(req.params.id, req.body, req.user.sub),
  );

  app.post<{ Params: { id: string }; Body: VehicleInput }>(
    '/:id/vehicles',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { ...vehicleFieldProps },
        },
      },
    },
    async (req, reply) => {
      const vehicle = await service.addVehicle(req.params.id, req.body, req.user.sub);
      return reply.code(201).send(vehicle);
    },
  );

  app.patch<{ Params: { id: string; vehicleId: string }; Body: VehicleInput }>(
    '/:id/vehicles/:vehicleId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'vehicleId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            vehicleId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { ...vehicleFieldProps },
        },
      },
    },
    async (req, reply) => {
      await service.updateVehicle(req.params.id, req.params.vehicleId, req.body, req.user.sub);
      return reply.code(200).send({ ok: true });
    },
  );

  app.post<{ Params: { id: string }; Body: DocumentInput }>(
    '/:id/documents',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['requirementId'],
          additionalProperties: false,
          properties: {
            requirementId: { type: 'integer', minimum: 1 },
            vehicleId: { type: ['string', 'null'], format: 'uuid' },
            fileUrl: { type: ['string', 'null'], maxLength: 500 },
            expiresAt: { type: ['string', 'null'], format: 'date' },
          },
        },
      },
    },
    async (req, reply) => {
      const document = await service.addDocument(req.params.id, req.body, req.user.sub);
      return reply.code(201).send(document);
    },
  );

  app.post<{ Params: { id: string }; Body: EnrollInput }>(
    '/:id/enroll',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['planId', 'periods'],
          additionalProperties: false,
          properties: {
            planId: { type: 'integer', minimum: 1 },
            periods: { type: 'integer', minimum: 1, maximum: 520 },
            ...paymentMetaProps,
          },
        },
      },
    },
    async (req, reply) => {
      const result = await service.enroll(req.params.id, req.body, req.user.sub);
      return reply.code(201).send(result);
    },
  );

  app.post<{
    Params: { id: string };
    Body: { periods: number; planId?: number; note?: string | null } & PaymentMeta;
  }>(
    '/:id/subscription/renew',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['periods'],
          additionalProperties: false,
          properties: {
            periods: { type: 'integer', minimum: 1, maximum: 520 },
            // Optional: a different plan turns the renewal into a plan change
            planId: { type: 'integer', minimum: 1 },
            // Optional note (constancia), e.g. "part by transfer, rest in cash"
            note: { type: ['string', 'null'], maxLength: 1000 },
            // Optional payment details (Pieza 2): stamped on the renewal's invoice
            ...paymentMetaProps,
          },
        },
      },
    },
    async (req, reply) => {
      const result = await service.renewSubscription(req.params.id, req.body, req.user.sub);
      return reply.code(201).send(result);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/:id/subscription/cancel-change',
    { schema: { params: idParam } },
    async (req) => service.cancelScheduledChange(req.params.id, req.user.sub),
  );

  app.post<{ Params: { id: string }; Body: { startMode: 'now' | 'next_monday' } }>(
    '/:id/approve',
    {
      schema: {
        params: idParam,
        // The admin MUST pick when the tariff starts: `now` (current-week Monday,
        // active at once) or `next_monday` (starts next Monday; driver stays
        // `scheduled`/programado until then). No implicit default — it's a choice.
        body: {
          type: 'object',
          required: ['startMode'],
          additionalProperties: false,
          properties: {
            startMode: { type: 'string', enum: ['now', 'next_monday'] },
          },
        },
      },
    },
    async (req) => {
      await service.approve(req.params.id, req.user.sub, req.body.startMode);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/:id/reject',
    { schema: { params: idParam } },
    async (req) => service.reject(req.params.id, req.user.sub),
  );

  // Administrative pause (licencia): approved + tariff up to date -> paused.
  app.post<{ Params: { id: string } }>(
    '/:id/pause',
    { schema: { params: idParam } },
    async (req) => service.pause(req.params.id, req.user.sub),
  );

  // Lift the pause: paused -> approved + available, tariff resumes running.
  app.post<{ Params: { id: string } }>(
    '/:id/resume',
    { schema: { params: idParam } },
    async (req) => service.resume(req.params.id, req.user.sub),
  );

  // External payment (v8): settles the outstanding charges (arrears + penalty)
  // received outside the system and issues their invoice. The debt engine then
  // derives the driver out of overdue/penalized - no state is forced by hand.
  app.post<{
    Params: { id: string };
    Body?: { note?: string | null } & PaymentMeta;
  }>(
    '/:id/external-payment',
    {
      schema: {
        params: idParam,
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { note: { type: ['string', 'null'], maxLength: 1000 }, ...paymentMetaProps },
        },
      },
    },
    async (req, reply) => {
      const result = await service.registerExternalPayment(
        req.params.id,
        {
          note: req.body?.note ?? null,
          paymentMethodId: req.body?.paymentMethodId ?? null,
          reference: req.body?.reference ?? null,
          payerBank: req.body?.payerBank ?? null,
          paidOn: req.body?.paidOn ?? null,
          payerPhone: req.body?.payerPhone ?? null,
          payerId: req.body?.payerId ?? null,
          payerAccount: req.body?.payerAccount ?? null,
        },
        req.user.sub,
      );
      return reply.code(201).send(result);
    },
  );

  // Manual reactivation (v8): back on the road now instead of waiting for the
  // automatic reactivation moment. Requires the debt to be settled.
  app.post<{ Params: { id: string } }>(
    '/:id/reactivate',
    { schema: { params: idParam } },
    async (req) => service.reactivate(req.params.id, req.user.sub),
  );
};

export default driversRoutes;
