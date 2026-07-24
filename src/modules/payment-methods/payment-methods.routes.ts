import type { FastifyPluginAsync } from 'fastify';
import { PaymentMethodsRepository } from './payment-methods.repository.js';
import { PaymentMethodsService } from './payment-methods.service.js';
import {
  createPaymentMethodSchema,
  deletePaymentMethodSchema,
  listPaymentMethodsSchema,
  updatePaymentMethodSchema,
} from './payment-methods.schemas.js';

interface Details {
  [key: string]: unknown;
}

const paymentMethodsRoutes: FastifyPluginAsync = async (app) => {
  const service = new PaymentMethodsService(app, new PaymentMethodsRepository(app.db));

  app.addHook('onRequest', app.authenticate);

  app.get('/', { schema: listPaymentMethodsSchema }, async () => service.list());

  app.post<{ Body: { name: string; type: string; details: Details } }>(
    '/',
    { schema: createPaymentMethodSchema },
    async (req, reply) => {
      const record = await service.create(req.body, req.user.sub);
      return reply.code(201).send(record);
    },
  );

  app.patch<{
    Params: { id: number };
    Body: { name?: string; type?: string; details?: Details; isActive?: boolean };
  }>('/:id', { schema: updatePaymentMethodSchema }, async (req) =>
    service.update(req.params.id, req.body, req.user.sub),
  );

  app.delete<{ Params: { id: number } }>(
    '/:id',
    { schema: deletePaymentMethodSchema },
    async (req, reply) => {
      await service.delete(req.params.id, req.user.sub);
      return reply.code(204).send();
    },
  );
};

export default paymentMethodsRoutes;
