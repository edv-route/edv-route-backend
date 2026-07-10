import type { FastifyPluginAsync } from 'fastify';
import { AdminsRepository } from '../admins/admins.repository.js';
import { AuthService } from './auth.service.js';
import { loginSchema, meSchema } from './auth.schemas.js';

interface LoginBody {
  username: string;
  password: string;
}

const authRoutes: FastifyPluginAsync = async (app) => {
  const service = new AuthService(app, new AdminsRepository(app.db));

  app.post<{ Body: LoginBody }>('/login', { schema: loginSchema }, async (req) => {
    return service.login(req.body.username, req.body.password);
  });

  app.get(
    '/me',
    { onRequest: [app.authenticate], schema: meSchema },
    async (req) => service.getProfile(req.user.sub),
  );
};

export default authRoutes;
