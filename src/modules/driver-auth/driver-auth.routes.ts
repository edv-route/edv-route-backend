import type { FastifyPluginAsync } from 'fastify';
import { DriversRepository } from '../drivers/drivers.repository.js';
import { EnrollmentRepository } from '../drivers/enrollment.repository.js';
import { DriversService } from '../drivers/drivers.service.js';
import { ApplicationsService } from '../drivers/applications.service.js';
import { PaymentSubmissionsRepository } from '../payment-submissions/payment-submissions.repository.js';
import {
  PaymentSubmissionsService,
  type UploadedFile,
} from '../payment-submissions/payment-submissions.service.js';
import type { CreateDriverInput, DocumentInput, VehicleInput } from '../drivers/drivers.service.js';
import type { SelfProfileInput } from './driver-auth.service.js';
import { vehicleFieldProps } from '../drivers/drivers.schemas.js';
import { DocumentsRepository } from '../documents/documents.repository.js';
import { DocumentsService } from '../documents/documents.service.js';
import { SettingsRepository } from '../settings/settings.repository.js';
import { VehicleImagesRepository } from '../vehicles/vehicle-images.repository.js';
import { VehicleImagesService } from '../vehicles/vehicle-images.service.js';
import { DriverAuthRepository } from './driver-auth.repository.js';
import { DriverAuthService } from './driver-auth.service.js';
import {
  appAccountSchema,
  appAvailabilitySchema,
  appDebtSchema,
  appMembershipSchema,
  appPaymentMethodsSchema,
  appPlansSchema,
  appRequirementsSchema,
  appSelfUpdateSchema,
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

/** Applicant adds a vehicle to his own solicitud (born pending). */
const applicantVehicleBody = {
  type: 'object',
  additionalProperties: false,
  properties: { ...vehicleFieldProps },
} as const;

/** Applicant adds a document (metadata) to his own solicitud (born pending). */
const applicantDocumentBody = {
  type: 'object',
  required: ['requirementId'],
  additionalProperties: false,
  properties: {
    requirementId: { type: 'integer', minimum: 1 },
    vehicleId: { type: 'string', format: 'uuid' },
    expiresAt: { type: ['string', 'null'], format: 'date' },
  },
} as const;

/** Driver (mobile app) authentication: national_id + password. */
const driverAuthRoutes: FastifyPluginAsync = async (app) => {
  const enrollment = new EnrollmentRepository(app.db);
  const driversRepository = new DriversRepository(app.db);
  const driversService = new DriversService(app, driversRepository, enrollment);
  const applications = new ApplicationsService(app, enrollment, driversService);
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
  const service = new DriverAuthService(
    app,
    new DriverAuthRepository(app.db),
    driversService,
    driversRepository,
  );

  app.post<{ Body: DriverLoginBody }>('/login', { schema: driverLoginSchema }, async (req) =>
    service.login(req.body.nationalId, req.body.password),
  );

  // Public self-service registration - STEP 1 ONLY (proposal: solicitudes-app):
  // personal data + credentials + privacy consent. Creates an `applicant` and
  // returns a driver token so the app can log in and complete the solicitud
  // (documents + vehicles) afterwards.
  app.post<{
    Body: CreateDriverInput & { acceptedPrivacy?: boolean };
  }>('/register', { schema: driverRegisterSchema }, async (req, reply) => {
    const { acceptedPrivacy, ...person } = req.body;
    const result = await service.register(person, acceptedPrivacy ?? false);
    return reply.code(201).send(result);
  });

  // Payment submission from the app: the driver submits ONE payment (receipt +
  // payer details) for his own alta. `driverId` comes from the TOKEN, never the
  // URL, so a driver can only submit for himself. The app may use `enroll` (the
  // alta: membership + N weeks) or `debt`; `advance`/`change_plan` stay admin-only.
  // It always stays `pending` (a driver never auto-approves his own payment).
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
    // The app pays the alta (`enroll`, membership + N weeks) or settles `debt`.
    // Admin-only purposes are rejected here. `periods` (weeks) applies to enroll.
    const rawPurpose = fields['purpose'] ?? 'debt';
    if (rawPurpose !== 'debt' && rawPurpose !== 'enroll') {
      throw app.httpErrors.badRequest('Tipo de pago no permitido desde la app');
    }
    const purpose = rawPurpose as 'debt' | 'enroll';
    // `periods` applies to enroll (membership + N weeks) and to a debt payment that
    // prepays advance weeks at the alta (Forma A): the TOTAL weeks the applicant
    // pays (>= 1; the base week plus any extra).
    const rawPeriods = fields['periods'] ? Number(fields['periods']) : null;
    if (rawPeriods !== null && (!Number.isInteger(rawPeriods) || rawPeriods < 1)) {
      throw app.httpErrors.badRequest('El número de semanas no es válido');
    }
    const periods = rawPeriods;
    // Gate (solicitudes-app): an applicant cannot pay yet; paying requires
    // accepting the terms & conditions (stamps accepted_terms_at).
    await service.assertPayableAndAcceptTerms(req.user.sub, fields['acceptedTerms'] === 'true');
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
        purpose,
        periods,
        planId: null,
        invoiceIds: null,
        // The app never auto-approves: a driver cannot approve his own payment.
        autoApprove: false,
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

  // Read one of the driver's OWN document files: a short-lived signed URL so the
  // app can PREVIEW what he uploaded. The service checks the document resolves to
  // this driver (404 otherwise). Read-only counterpart of POST /documents/:id/file.
  app.get<{ Params: { id: string } }>(
    '/documents/:id/file',
    { onRequest: [app.authenticateDriver], schema: { params: documentIdParam } },
    async (req) => documents.getFileUrl(req.params.id, req.user.sub),
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

  // Self-service edit: phone / email / address / password ONLY. Names and
  // national id are the admin-verified identity and are not editable here.
  app.patch<{ Body: SelfProfileInput }>(
    '/me',
    { onRequest: [app.authenticateDriver], schema: appSelfUpdateSchema },
    async (req) => service.updateOwnProfile(req.user.sub, req.body),
  );

  // The driver replaces his OWN profile photo. Multipart, like every other
  // upload: the file goes to the private bucket and only its path is stored.
  app.post('/me/photo', { onRequest: [app.authenticateDriver] }, async (req) => {
    const file = await req.file();
    if (!file) throw app.httpErrors.badRequest('No se recibió ninguna imagen');
    const buffer = await file.toBuffer().catch(() => {
      throw app.httpErrors.badRequest('La imagen supera el máximo de 10 MB');
    });
    return service.replacePhoto(req.user.sub, { buffer, mimeType: file.mimetype });
  });

  // Which of his vehicles he is operating with. Choosing one releases the
  // previous automatically; only an approved vehicle can be chosen.
  app.patch<{ Params: { vehicleId: string } }>(
    '/me/vehicles/:vehicleId/primary',
    { onRequest: [app.authenticateDriver], schema: { params: vehicleIdParam } },
    async (req) => service.setPrimaryVehicle(req.user.sub, req.params.vehicleId),
  );

  // The driver puts himself on or off duty. Going ON is refused when his status
  // does not allow operating (penalized/paused) — the switch cannot buy him back
  // onto the road.
  app.patch<{ Body: { available: boolean } }>(
    '/me/availability',
    { onRequest: [app.authenticateDriver], schema: appAvailabilitySchema },
    async (req) => service.setAvailability(req.user.sub, req.body.available),
  );

  // Address prefill for the edit form (the rest of the fields travel in /me).
  app.get(
    '/me/editable',
    { onRequest: [app.authenticateDriver] },
    async (req) => service.getEditableData(req.user.sub),
  );

  // "Completa tu solicitud" — the applicant's document/vehicle checklist with
  // per-item review state (missing / en revisión / aprobado / rechazado + motivo).
  app.get(
    '/me/checklist',
    { onRequest: [app.authenticateDriver] },
    async (req) => service.getChecklist(req.user.sub),
  );

  // The driver's vehicles with full detail + signed photo URLs, for the profile's
  // vehicle catalog/detail.
  app.get(
    '/me/vehicles',
    { onRequest: [app.authenticateDriver] },
    async (req) => service.getVehicles(req.user.sub),
  );

  // The driver's alta/arrears debt (for the app's deferred payment screen).
  app.get(
    '/me/debt',
    { onRequest: [app.authenticateDriver], schema: appDebtSchema },
    async (req) => service.getDebt(req.user.sub),
  );

  // Account standing for the profile: until when the tariff is covered, which
  // charge comes next (or when it will be emitted) and how deep the arrears are.
  app.get(
    '/me/account',
    { onRequest: [app.authenticateDriver], schema: appAccountSchema },
    async (req) => service.getAccount(req.user.sub),
  );

  // Applicant adds a vehicle to his OWN solicitud (driverId from the token; born
  // pending). Images are uploaded afterwards via /vehicles/:vehicleId/images.
  app.post<{ Body: VehicleInput }>(
    '/me/vehicles',
    { onRequest: [app.authenticateDriver], schema: { body: applicantVehicleBody } },
    async (req, reply) => {
      const vehicle = await applications.addApplicantVehicle(req.user.sub, req.body);
      return reply.code(201).send(vehicle);
    },
  );

  // Applicant adds a document (metadata) to his OWN solicitud (born pending). The
  // file is attached afterwards via /documents/:id/file.
  app.post<{ Body: DocumentInput }>(
    '/me/documents',
    { onRequest: [app.authenticateDriver], schema: { body: applicantDocumentBody } },
    async (req, reply) => {
      const doc = await applications.addApplicantDocument(req.user.sub, req.body);
      return reply.code(201).send(doc);
    },
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

  // Enrollment cost catalog: current membership + active tariffs, so the app can
  // show the alta total (membership + weekly tariff × weeks) BEFORE paying —
  // mirrors the panel's /memberships/current + /subscription-plans.
  app.get('/membership', { schema: appMembershipSchema }, async () =>
    service.getCurrentMembership(),
  );

  app.get('/subscription-plans', { schema: appPlansSchema }, async () =>
    service.listActivePlans(),
  );
};

export default driverAuthRoutes;
