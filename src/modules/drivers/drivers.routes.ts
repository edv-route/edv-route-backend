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

const vehicleParams = {
  type: 'object',
  required: ['id', 'vehicleId'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    vehicleId: { type: 'string', format: 'uuid' },
  },
} as const;

/** Reject action body: a reason the applicant sees (required on reject). */
const reviewBody = {
  type: 'object',
  additionalProperties: false,
  properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
} as const;

const driversRoutes: FastifyPluginAsync = async (app) => {
  const service = new DriversService(
    app,
    new DriversRepository(app.db),
    new EnrollmentRepository(app.db),
  );

  app.addHook('onRequest', app.authenticate);

  app.get<{
    Querystring: { status?: string; source?: string; search?: string; page?: number; limit?: number };
  }>(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: {
              type: 'string',
              enum: ['applicant', 'pending', 'scheduled', 'approved', 'rejected', 'suspended', 'paused', 'overdue', 'penalized'],
            },
            // Channel filter (solicitudes-app): the admin's Solicitudes list uses
            // source=app & status=applicant; Afiliados excludes applicant.
            source: { type: 'string', enum: ['app', 'admin'] },
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
        ...(req.query.source !== undefined ? { source: req.query.source } : {}),
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

  // Vehicle review (solicitudes-app): approve, or reject with a reason.
  app.post<{ Params: { id: string; vehicleId: string } }>(
    '/:id/vehicles/:vehicleId/approve',
    { schema: { params: vehicleParams } },
    async (req, reply) => {
      await service.reviewVehicle(req.params.id, req.params.vehicleId, true, null, req.user.sub);
      return reply.code(200).send({ ok: true });
    },
  );

  app.post<{ Params: { id: string; vehicleId: string }; Body: { reason?: string } }>(
    '/:id/vehicles/:vehicleId/reject',
    { schema: { params: vehicleParams, body: reviewBody } },
    async (req, reply) => {
      await service.reviewVehicle(
        req.params.id,
        req.params.vehicleId,
        false,
        req.body?.reason ?? null,
        req.user.sub,
      );
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

  // Approve a PENDING affiliate (panel). Tariff start is DECOUPLED now
  // (solicitudes-app): set it afterwards with /start-tariff. No startMode here.
  app.post<{ Params: { id: string } }>(
    '/:id/approve',
    { schema: { params: idParam } },
    async (req) => {
      await service.approve(req.params.id, req.user.sub);
      return { ok: true };
    },
  );

  // Set when the tariff starts ("Establecer inicio"): `now` (current-week Monday,
  // active at once) or `next_monday` (scheduled/programado until then). Requires
  // the affiliate approved with the start not set, payment settled and zero debt.
  app.post<{ Params: { id: string }; Body: { startMode: 'now' | 'next_monday' } }>(
    '/:id/start-tariff',
    {
      schema: {
        params: idParam,
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
      await service.startTariff(req.params.id, req.user.sub, req.body.startMode);
      return { ok: true };
    },
  );

  // Approve an app SOLICITUD: applicant -> approved + base debt. Requires every
  // document and vehicle approved and at least one vehicle.
  app.post<{ Params: { id: string } }>(
    '/:id/approve-application',
    { schema: { params: idParam } },
    async (req) => service.approveApplication(req.params.id, req.user.sub),
  );

  // Reject an app SOLICITUD: applicant -> rejected. Policy 2026-08-13: kept on file,
  // no self-service re-registration; only an admin can reopen it.
  app.post<{ Params: { id: string } }>(
    '/:id/reject-application',
    { schema: { params: idParam } },
    async (req, reply) => {
      await service.rejectApplication(req.params.id, req.user.sub);
      return reply.code(200).send({ ok: true });
    },
  );

  // Reopen a REJECTED app SOLICITUD back to applicant for another review (the only
  // path back for a rejected applicant — self-service re-registration is blocked).
  app.post<{ Params: { id: string } }>(
    '/:id/reopen-application',
    { schema: { params: idParam } },
    async (req, reply) => {
      await service.reopenApplication(req.params.id, req.user.sub);
      return reply.code(200).send({ ok: true });
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

  // Manual reactivation (v8): back on the road now instead of waiting for the
  // automatic reactivation moment. Requires the debt to be settled.
  app.post<{ Params: { id: string } }>(
    '/:id/reactivate',
    { schema: { params: idParam } },
    async (req) => service.reactivate(req.params.id, req.user.sub),
  );
};

export default driversRoutes;
