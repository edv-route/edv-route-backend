import type { FastifyPluginAsync } from 'fastify';
import { AdminsRepository, type UpdateAdminData } from './admins.repository.js';
import { AdminsService } from './admins.service.js';
import {
  createAdminSchema,
  getAdminSchema,
  listAdminsSchema,
  updateAdminPasswordSchema,
  updateAdminSchema,
} from './admins.schemas.js';

interface CreateBody {
  username: string;
  email?: string | null;
  fullName: string;
  password: string;
}

const adminsRoutes: FastifyPluginAsync = async (app) => {
  const service = new AdminsService(app, new AdminsRepository(app.db));

  // Every admins endpoint requires an authenticated admin
  app.addHook('onRequest', app.authenticate);

  app.get('/', { schema: listAdminsSchema }, async () => service.list());

  app.get<{ Params: { id: string } }>(
    '/:id',
    { schema: getAdminSchema },
    async (req) => service.getById(req.params.id),
  );

  app.post<{ Body: CreateBody }>(
    '/',
    { schema: createAdminSchema },
    async (req, reply) => {
      const admin = await service.create({ ...req.body, createdBy: req.user.sub });
      return reply.code(201).send(admin);
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateAdminData }>(
    '/:id',
    { schema: updateAdminSchema },
    async (req) => service.update(req.params.id, req.body, req.user.sub),
  );

  app.put<{ Params: { id: string }; Body: { password: string } }>(
    '/:id/password',
    { schema: updateAdminPasswordSchema },
    async (req, reply) => {
      await service.updatePassword(req.params.id, req.body.password);
      return reply.code(204).send();
    },
  );
};

export default adminsRoutes;
