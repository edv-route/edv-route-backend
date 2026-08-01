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

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

/**
 * Optional payment details captured at cobro time (Pieza 2 + payer details
 * 2026-07-31). `reference` is a code: letters/digits/space, max 50. The payer
 * phone/id are only meaningful for Pago Móvil (validated client-side per
 * method); here they are just bounded, canonical-format strings.
 */
const paymentMetaProps = {
  paymentMethodId: { type: ['integer', 'null'], minimum: 1 },
  reference: { type: ['string', 'null'], maxLength: 25, pattern: '^[\\p{L}\\p{N}]+(?: [\\p{L}\\p{N}]+)*$' },
  payerBank: { type: ['string', 'null'], maxLength: 120 },
  paidOn: { type: ['string', 'null'], format: 'date' },
  payerPhone: { type: ['string', 'null'], pattern: '^\\+58\\d{10}$' },
  payerId: { type: ['string', 'null'], pattern: '^[VEJ]-\\d{5,9}$' },
  // Email or name the payment came FROM (Zelle/Binance)
  payerAccount: { type: ['string', 'null'], maxLength: 100 },
} as const;

/**
 * Personal data contract (2026-07-16): names split (first/last required),
 * canonical formats validated at the edge - document "V-12345678", phone
 * E.164 "+58" + 10 digits, adult birth date (age rule lives in the service).
 * Document + password are mandatory when registering from the panel: they
 * are the driver's app login (enforced by the client; the API keeps them
 * optional so an app-side registration can define its own flow).
 */
// Names: letters (incl. accents/ñ) with SINGLE space/hyphen/apostrophe
// separators between them — no digits/symbols, no doubled or edge separator
// ("Ana--", "-Ana"). Max 80. Kept in sync with the frontend `appLetters`.
const NAME_PATTERN = "^\\p{L}+(?:[ '-]\\p{L}+)*$";

// Vehicle text fields (kept in sync with the frontend directives): brand/model
// allow letters, digits, space and hyphen (real model names: "Mazda 3",
// "F-150"); color allows letters and space only. Shared by the 3 vehicle
// schemas (embedded in register, POST and PATCH /vehicles).
const BRAND_MODEL_PATTERN = '^[\\p{L}\\p{N}]+(?:[ -][\\p{L}\\p{N}]+)*$';
const COLOR_PATTERN = '^\\p{L}+(?: \\p{L}+)*$';
const vehicleFieldProps = {
  vehicleTypeId: { type: ['integer', 'null'], minimum: 1 },
  brand: { type: ['string', 'null'], maxLength: 60, pattern: BRAND_MODEL_PATTERN },
  model: { type: ['string', 'null'], maxLength: 60, pattern: BRAND_MODEL_PATTERN },
  year: { type: ['integer', 'null'], minimum: 1900, maximum: 2100 },
  color: { type: ['string', 'null'], maxLength: 30, pattern: COLOR_PATTERN },
  plate: { type: ['string', 'null'], maxLength: 15 },
} as const;
const personProperties = {
  firstName: { type: 'string', minLength: 2, maxLength: 80, pattern: NAME_PATTERN },
  middleName: { type: ['string', 'null'], maxLength: 80, pattern: NAME_PATTERN },
  lastName: { type: 'string', minLength: 2, maxLength: 80, pattern: NAME_PATTERN },
  secondLastName: { type: ['string', 'null'], maxLength: 80, pattern: NAME_PATTERN },
  birthDate: { type: ['string', 'null'], format: 'date' },
  address: { type: ['string', 'null'], maxLength: 500 },
  email: { type: ['string', 'null'], format: 'email' },
  phone: { type: ['string', 'null'], pattern: '^\\+58\\d{10}$' },
  // V = venezolano · E = extranjero · J = jurídico (RIF)
  nationalId: { type: ['string', 'null'], pattern: '^[VEJ]-\\d{5,9}$' },
  // Driver app password: min 6, digits-only allowed (PIN-like, decision
  // 2026-07-16). It guards the driver's app, not the admin panel.
  password: { type: ['string', 'null'], minLength: 6, maxLength: 72 },
} as const;

const createBody = {
  type: 'object',
  required: ['firstName', 'lastName'],
  additionalProperties: false,
  properties: personProperties,
} as const;

/**
 * Transactional registration (2026-07-21): personal data plus optional
 * vehicles, document metadata and a payment - all persisted in one transaction.
 * Document FILES are uploaded afterwards against the returned document ids.
 */
const registerBody = {
  type: 'object',
  required: ['firstName', 'lastName'],
  additionalProperties: false,
  properties: {
    ...personProperties,
    payment: {
      type: ['object', 'null'],
      required: ['planId', 'periods'],
      additionalProperties: false,
      properties: {
        planId: { type: 'integer', minimum: 1 },
        periods: { type: 'integer', minimum: 1, maximum: 520 },
        ...paymentMetaProps,
      },
    },
    vehicles: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...vehicleFieldProps,
          documents: {
            type: 'array',
            maxItems: 30,
            items: {
              type: 'object',
              required: ['requirementId'],
              additionalProperties: false,
              properties: {
                requirementId: { type: 'integer', minimum: 1 },
                expiresAt: { type: ['string', 'null'], format: 'date' },
              },
            },
          },
        },
      },
    },
    documents: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        required: ['requirementId'],
        additionalProperties: false,
        properties: {
          requirementId: { type: 'integer', minimum: 1 },
          expiresAt: { type: ['string', 'null'], format: 'date' },
        },
      },
    },
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
            status: {
              type: 'string',
              enum: ['pending', 'approved', 'rejected', 'suspended', 'paused', 'overdue', 'penalized'],
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
    };
  }>(
    '/register',
    { schema: { body: registerBody } },
    async (req, reply) => {
      const { payment, vehicles, documents, ...person } = req.body;
      const detail = await service.register(
        person,
        { payment: payment ?? null, vehicles: vehicles ?? [], documents: documents ?? [] },
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
