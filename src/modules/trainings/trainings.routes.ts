import type { FastifyPluginAsync } from 'fastify';
import { TrainingsRepository } from './trainings.repository.js';
import { TrainingsService, } from './trainings.service.js';
import type { TrainingInput } from './trainings.repository.js';

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const trainingBody = {
  type: 'object',
  required: ['title', 'startsAt'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 3, maxLength: 150 },
    description: { type: ['string', 'null'], maxLength: 2000 },
    location: { type: ['string', 'null'], maxLength: 200 },
    startsAt: { type: 'string', format: 'date-time' },
    endsAt: { type: ['string', 'null'], format: 'date-time' },
    capacity: { type: ['integer', 'null'], minimum: 1 },
  },
} as const;

const trainingsRoutes: FastifyPluginAsync = async (app) => {
  const service = new TrainingsService(app, new TrainingsRepository(app.db));

  app.addHook('onRequest', app.authenticate);

  app.get<{ Querystring: { status?: string; page?: number; limit?: number } }>(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['scheduled', 'cancelled', 'completed'] },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req) =>
      service.list({
        ...(req.query.status !== undefined ? { status: req.query.status } : {}),
        page: req.query.page ?? 1,
        limit: req.query.limit ?? 20,
      }),
  );

  app.get<{ Params: { id: number } }>('/:id', { schema: { params: idParam } }, async (req) =>
    service.getDetail(req.params.id),
  );

  app.post<{ Body: TrainingInput }>('/', { schema: { body: trainingBody } }, async (req, reply) => {
    const detail = await service.create(
      {
        title: req.body.title,
        description: req.body.description ?? null,
        location: req.body.location ?? null,
        startsAt: req.body.startsAt,
        endsAt: req.body.endsAt ?? null,
        capacity: req.body.capacity ?? null,
      },
      req.user.sub,
    );
    return reply.code(201).send(detail);
  });

  app.put<{ Params: { id: number }; Body: TrainingInput }>(
    '/:id',
    { schema: { params: idParam, body: trainingBody } },
    async (req) =>
      service.update(
        req.params.id,
        {
          title: req.body.title,
          description: req.body.description ?? null,
          location: req.body.location ?? null,
          startsAt: req.body.startsAt,
          endsAt: req.body.endsAt ?? null,
          capacity: req.body.capacity ?? null,
        },
        req.user.sub,
      ),
  );

  app.patch<{ Params: { id: number }; Body: { status: 'cancelled' | 'completed' } }>(
    '/:id/status',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['cancelled', 'completed'] } },
        },
      },
    },
    async (req) => service.setStatus(req.params.id, req.body.status, req.user.sub),
  );

  app.post<{ Params: { id: number }; Body: { driverId: string } }>(
    '/:id/attendees',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['driverId'],
          additionalProperties: false,
          properties: { driverId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req, reply) => {
      const detail = await service.enroll(req.params.id, req.body.driverId, req.user.sub);
      return reply.code(201).send(detail);
    },
  );

  app.patch<{
    Params: { id: number; attendeeId: string };
    Body: { status: 'attended' | 'absent' | 'cancelled' };
  }>(
    '/:id/attendees/:attendeeId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'attendeeId'],
          properties: {
            id: { type: 'integer', minimum: 1 },
            attendeeId: { type: 'string', pattern: '^[0-9]+$' },
          },
        },
        body: {
          type: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['attended', 'absent', 'cancelled'] },
          },
        },
      },
    },
    async (req) =>
      service.setAttendeeStatus(req.params.id, req.params.attendeeId, req.body.status, req.user.sub),
  );
};

export default trainingsRoutes;
