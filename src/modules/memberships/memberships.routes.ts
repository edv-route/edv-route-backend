import type { FastifyPluginAsync } from 'fastify';
import { MembershipsRepository } from './memberships.repository.js';
import { MembershipsService, type MembershipInput } from './memberships.service.js';

const membershipSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    priceUsd: { type: 'string' },
    active: { type: 'boolean' },
    benefitIds: { type: 'array', items: { type: 'integer' } },
    memberCount: { type: 'integer' },
    createdBy: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const bodySchema = {
  type: 'object',
  required: ['name', 'priceUsd', 'benefitIds'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 3, maxLength: 120 },
    description: { type: ['string', 'null'], maxLength: 1000 },
    priceUsd: { type: 'number', minimum: 0, maximum: 100000 },
    benefitIds: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 100 },
  },
} as const;

const membershipsRoutes: FastifyPluginAsync = async (app) => {
  const service = new MembershipsService(app, new MembershipsRepository(app.db));

  app.addHook('onRequest', app.authenticate);

  app.get(
    '/',
    { schema: { response: { 200: { type: 'array', items: membershipSchema } } } },
    async () => service.list(),
  );

  app.get(
    '/current',
    { schema: { response: { 200: membershipSchema } } },
    async () => service.getCurrent(),
  );

  app.post<{ Body: MembershipInput }>(
    '/',
    { schema: { body: bodySchema, response: { 201: membershipSchema } } },
    async (req, reply) => {
      const record = await service.create(req.body, req.user.sub);
      return reply.code(201).send(record);
    },
  );

  app.put<{ Body: MembershipInput }>(
    '/current',
    { schema: { body: bodySchema, response: { 200: membershipSchema } } },
    async (req) => service.updateCurrent(req.body, req.user.sub),
  );
};

export default membershipsRoutes;
