import type { FastifyPluginAsync } from 'fastify';
import { DriverAuthRepository } from './driver-auth.repository.js';
import { DriverAuthService } from './driver-auth.service.js';
import {
  appPaymentMethodsSchema,
  appRequirementsSchema,
  driverLoginSchema,
  driverMeSchema,
} from './driver-auth.schemas.js';

interface DriverLoginBody {
  nationalId: string;
  password: string;
}

/** Driver (mobile app) authentication: national_id + password. */
const driverAuthRoutes: FastifyPluginAsync = async (app) => {
  const service = new DriverAuthService(app, new DriverAuthRepository(app.db));

  app.post<{ Body: DriverLoginBody }>('/login', { schema: driverLoginSchema }, async (req) =>
    service.login(req.body.nationalId, req.body.password),
  );

  app.get(
    '/me',
    { onRequest: [app.authenticateDriver], schema: driverMeSchema },
    async (req) => service.getProfile(req.user.sub),
  );

  // Public catalogs the registration wizard needs before the driver has an account.
  app.get('/requirements', { schema: appRequirementsSchema }, async () =>
    service.listRequirements(),
  );

  app.get('/payment-methods', { schema: appPaymentMethodsSchema }, async () =>
    service.listPaymentMethods(),
  );
};

export default driverAuthRoutes;
