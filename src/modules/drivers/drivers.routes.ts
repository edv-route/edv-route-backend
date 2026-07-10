import type { FastifyPluginAsync } from 'fastify';
import { DriversRepository } from './drivers.repository.js';
import { EnrollmentRepository } from './enrollment.repository.js';
import {
  DriversService,
  type CreateDriverInput,
  type DocumentInput,
  type EnrollInput,
  type VehicleInput,
} from './drivers.service.js';

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const createBody = {
  type: 'object',
  required: ['fullName'],
  additionalProperties: false,
  properties: {
    fullName: { type: 'string', minLength: 3, maxLength: 120 },
    email: { type: ['string', 'null'], format: 'email' },
    phone: { type: ['string', 'null'], maxLength: 20 },
    nationalId: { type: ['string', 'null'], minLength: 5, maxLength: 20 },
  },
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
            status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'suspended'] },
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

  app.patch<{ Params: { id: string }; Body: CreateDriverInput & { status?: 'approved' | 'suspended' } }>(
    '/:id',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            fullName: { type: 'string', minLength: 3, maxLength: 120 },
            email: { type: ['string', 'null'], format: 'email' },
            phone: { type: ['string', 'null'], maxLength: 20 },
            nationalId: { type: ['string', 'null'], minLength: 5, maxLength: 20 },
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
          properties: {
            vehicleTypeId: { type: ['integer', 'null'], minimum: 1 },
            brand: { type: ['string', 'null'], maxLength: 60 },
            model: { type: ['string', 'null'], maxLength: 60 },
            year: { type: ['integer', 'null'], minimum: 1950, maximum: 2100 },
            color: { type: ['string', 'null'], maxLength: 30 },
            plate: { type: ['string', 'null'], maxLength: 15 },
          },
        },
      },
    },
    async (req, reply) => {
      await service.addVehicle(req.params.id, req.body, req.user.sub);
      return reply.code(201).send({ ok: true });
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
      await service.addDocument(req.params.id, req.body, req.user.sub);
      return reply.code(201).send({ ok: true });
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
            periods: { type: 'integer', minimum: 1, maximum: 52 },
          },
        },
      },
    },
    async (req, reply) => {
      const result = await service.enroll(req.params.id, req.body, req.user.sub);
      return reply.code(201).send(result);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/:id/approve',
    { schema: { params: idParam } },
    async (req) => {
      await service.approve(req.params.id, req.user.sub);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/:id/reject',
    { schema: { params: idParam } },
    async (req) => service.reject(req.params.id, req.user.sub),
  );
};

export default driversRoutes;
