import type { FastifyPluginAsync } from 'fastify';
import { DriversRepository } from '../drivers/drivers.repository.js';
import { EnrollmentRepository } from '../drivers/enrollment.repository.js';
import { DriversService } from '../drivers/drivers.service.js';
import { PaymentSubmissionsRepository } from '../payment-submissions/payment-submissions.repository.js';
import {
  PaymentSubmissionsService,
  type UploadedFile,
} from '../payment-submissions/payment-submissions.service.js';
import type {
  CreateDriverInput,
  EnrollInput,
  RegisterDocumentInput,
  RegisterVehicleInput,
} from '../drivers/drivers.service.js';
import { DocumentsRepository } from '../documents/documents.repository.js';
import { DocumentsService } from '../documents/documents.service.js';
import { SettingsRepository } from '../settings/settings.repository.js';
import { VehicleImagesRepository } from '../vehicles/vehicle-images.repository.js';
import { VehicleImagesService } from '../vehicles/vehicle-images.service.js';
import { DriverAuthRepository } from './driver-auth.repository.js';
import { DriverAuthService } from './driver-auth.service.js';
import {
  appPaymentMethodsSchema,
  appRequirementsSchema,
  appVehicleTypesSchema,
  driverLoginSchema,
  driverMeSchema,
  driverRegisterSchema,
} from './driver-auth.schemas.js';

interface DriverLoginBody {
  nationalId: string;
  password: string;
}

const documentIdParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const vehicleIdParam = {
  type: 'object',
  required: ['vehicleId'],
  properties: { vehicleId: { type: 'string', format: 'uuid' } },
} as const;

/** Driver (mobile app) authentication: national_id + password. */
const driverAuthRoutes: FastifyPluginAsync = async (app) => {
  const enrollment = new EnrollmentRepository(app.db);
  const driversService = new DriversService(app, new DriversRepository(app.db), enrollment);
  const paymentSubmissions = new PaymentSubmissionsService(
    app,
    new PaymentSubmissionsRepository(app.db, enrollment),
  );
  const documents = new DocumentsService(
    app,
    new DocumentsRepository(app.db),
    new SettingsRepository(app.db),
  );
  const vehicleImages = new VehicleImagesService(app, new VehicleImagesRepository(app.db));
  const service = new DriverAuthService(app, new DriverAuthRepository(app.db), driversService);

  app.post<{ Body: DriverLoginBody }>('/login', { schema: driverLoginSchema }, async (req) =>
    service.login(req.body.nationalId, req.body.password),
  );

  // Public self-service registration (the 4-step wizard, all steps mandatory).
  // Emits the alta as debt (pending) and returns a driver token so the app can
  // then upload files and submit the payment against its own account.
  app.post<{
    Body: CreateDriverInput & {
      payment?: EnrollInput | null;
      vehicles?: RegisterVehicleInput[];
      documents?: RegisterDocumentInput[];
    };
  }>('/register', { schema: driverRegisterSchema }, async (req, reply) => {
    const { payment, vehicles, documents, ...person } = req.body;
    const result = await service.register(person, {
      payment: payment ?? null,
      vehicles: vehicles ?? [],
      documents: documents ?? [],
    });
    return reply.code(201).send(result);
  });

  // Payment submission from the app: the driver submits ONE payment (receipt +
  // payer details) against his own debt. `driverId` comes from the TOKEN, never
  // the URL, so a driver can only submit for himself; purpose is always the alta
  // debt (advance/enroll/change_plan stay admin-only). It remains `pending`.
  app.post('/payment-submissions', { onRequest: [app.authenticateDriver] }, async (req, reply) => {
    const fields: Record<string, string> = {};
    const files: UploadedFile[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer().catch(() => {
          throw app.httpErrors.badRequest('Un archivo supera el máximo de 10 MB');
        });
        files.push({ buffer, mimeType: part.mimetype });
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    const result = await paymentSubmissions.create(
      req.user.sub,
      {
        paymentMethodId: fields['paymentMethodId'] ? Number(fields['paymentMethodId']) : null,
        reference: fields['reference'] ?? null,
        payerBank: fields['payerBank'] ?? null,
        paidOn: fields['paidOn'] ?? null,
        payerPhone: fields['payerPhone'] ?? null,
        payerId: fields['payerId'] ?? null,
        payerAccount: fields['payerAccount'] ?? null,
        note: fields['note'] ?? null,
        amountUsd: null,
        purpose: 'debt',
        periods: null,
        planId: null,
        source: 'app',
        // submitted_by is an FK to admins; for the app channel it stays null and
        // the driver actor is recorded on audit_logs.actor_user_id (actorId below).
        submittedBy: null,
      },
      files,
      req.user.sub,
    );
    return reply.code(201).send(result);
  });

  // Attach a file to one of the driver's OWN documents (metadata created at
  // registration). The service checks the document resolves to this driver.
  app.post<{ Params: { id: string } }>(
    '/documents/:id/file',
    { onRequest: [app.authenticateDriver], schema: { params: documentIdParam } },
    async (req, reply) => {
      const file = await req.file();
      if (!file) throw app.httpErrors.badRequest('No se recibió ningún archivo');
      const buffer = await file.toBuffer().catch(() => {
        throw app.httpErrors.badRequest('El archivo supera el máximo de 10 MB');
      });
      const result = await documents.attachFile(
        req.params.id,
        { buffer, mimeType: file.mimetype },
        null,
        req.user.sub,
        req.user.sub,
      );
      return reply.code(201).send(result);
    },
  );

  // Add a photo to one of the driver's OWN vehicles. Ownership is enforced by
  // the service (vehicleBelongsToDriver) using the token's driver id.
  app.post<{ Params: { vehicleId: string } }>(
    '/vehicles/:vehicleId/images',
    { onRequest: [app.authenticateDriver], schema: { params: vehicleIdParam } },
    async (req, reply) => {
      const file = await req.file();
      if (!file) throw app.httpErrors.badRequest('No se recibió ninguna imagen');
      const buffer = await file.toBuffer().catch(() => {
        throw app.httpErrors.badRequest('La imagen supera el máximo de 10 MB');
      });
      const result = await vehicleImages.add(
        req.user.sub,
        req.params.vehicleId,
        { buffer, mimeType: file.mimetype },
        null,
        req.user.sub,
      );
      return reply.code(201).send(result);
    },
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

  app.get('/vehicle-types', { schema: appVehicleTypesSchema }, async () =>
    service.listVehicleTypes(),
  );
};

export default driverAuthRoutes;
