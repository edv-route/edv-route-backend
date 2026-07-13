import type { FastifyPluginAsync } from 'fastify';
import { SubscriptionPlansRepository } from './subscription-plans.repository.js';
import {
  SubscriptionPlansService,
  type SubscriptionPlanInput,
} from './subscription-plans.service.js';

const planSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    billingPeriod: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'annual'] },
    priceUsd: { type: 'string' },
    allowedVehicleTypes: { type: ['array', 'null'], items: { type: 'integer' } },
    active: { type: 'boolean' },
    createdBy: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const bodySchema = {
  type: 'object',
  required: ['name', 'billingPeriod', 'priceUsd'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 3, maxLength: 120 },
    description: { type: ['string', 'null'], maxLength: 500 },
    billingPeriod: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'annual'] },
    priceUsd: { type: 'number', minimum: 0, maximum: 100000 },
    allowedVehicleTypeIds: {
      type: ['array', 'null'],
      items: { type: 'integer', minimum: 1 },
      maxItems: 50,
    },
  },
} as const;

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const subscriptionPlansRoutes: FastifyPluginAsync = async (app) => {
  const service = new SubscriptionPlansService(app, new SubscriptionPlansRepository(app.db));

  app.addHook('onRequest', app.authenticate);

  app.get(
    '/',
    { schema: { response: { 200: { type: 'array', items: planSchema } } } },
    async () => service.list(),
  );

  app.post<{ Body: SubscriptionPlanInput }>(
    '/',
    { schema: { body: bodySchema, response: { 201: planSchema } } },
    async (req, reply) => {
      const record = await service.create(
        { ...req.body, allowedVehicleTypeIds: req.body.allowedVehicleTypeIds ?? null },
        req.user.sub,
      );
      return reply.code(201).send(record);
    },
  );

  app.put<{ Params: { id: number }; Body: SubscriptionPlanInput }>(
    '/:id',
    { schema: { params: idParam, body: bodySchema, response: { 200: planSchema } } },
    async (req) =>
      service.update(
        req.params.id,
        { ...req.body, allowedVehicleTypeIds: req.body.allowedVehicleTypeIds ?? null },
        req.user.sub,
      ),
  );

  app.patch<{ Params: { id: number }; Body: { active: boolean } }>(
    '/:id/active',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['active'],
          additionalProperties: false,
          properties: { active: { type: 'boolean' } },
        },
        response: { 200: planSchema },
      },
    },
    async (req) => service.setActive(req.params.id, req.body.active, req.user.sub),
  );
};

export default subscriptionPlansRoutes;
