import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { DriversService } from '../drivers/drivers.service.js';
import type { CreateDriverInput, RegisterInput } from '../drivers/drivers.service.js';
import type { DriverAuthRepository, DriverProfile } from './driver-auth.repository.js';

// Verified against when the national id is unknown or has no app password, so
// both paths cost the same time (prevents user enumeration via response timing).
const DUMMY_HASH_PROMISE = argon2.hash('timing-equalizer-dummy-password');

export interface DriverLoginResult {
  token: string;
  driver: DriverProfile;
}

export interface DriverRegisterResult {
  token: string;
  driver: DriverProfile;
  createdDocumentIds: string[];
  createdVehicles: { id: string; documentIds: string[] }[];
}

export class DriverAuthService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly drivers: DriverAuthRepository,
    private readonly driversService: DriversService,
  ) {}

  async login(nationalId: string, password: string): Promise<DriverLoginResult> {
    const { httpErrors } = this.app;
    const record = await this.drivers.findAuthByNationalId(nationalId.trim());

    // Unknown national id OR a driver without an app password cannot log in.
    if (!record?.passwordHash) {
      await argon2.verify(await DUMMY_HASH_PROMISE, password).catch(() => false);
      throw httpErrors.unauthorized('Cédula o clave incorrectas');
    }

    const validPassword = await argon2.verify(record.passwordHash, password);
    if (!validPassword) {
      throw httpErrors.unauthorized('Cédula o clave incorrectas');
    }

    const token = this.app.jwt.sign({ sub: record.userId, type: 'driver' });

    // Gating is open by decision: any driver with valid credentials logs in and
    // the app routes by `status` (in review / blocked / home). Failed-attempt
    // lockout is deferred — drivers have no lockout columns yet.
    const { passwordHash: _passwordHash, ...driver } = record;
    return { token, driver };
  }

  async getProfile(userId: string): Promise<DriverProfile> {
    const driver = await this.drivers.findProfileById(userId);
    if (!driver) {
      throw this.app.httpErrors.unauthorized('Sesión inválida');
    }
    return driver;
  }

  /** Active requirements (driver + vehicle) the registration wizard asks for. */
  listRequirements() {
    return this.drivers.listActiveRequirements();
  }

  /** App payment catalog: active, non-admin-only methods (never cash_usd). */
  listPaymentMethods() {
    return this.drivers.listAppPaymentMethods();
  }

  /** Active vehicle types the registration wizard offers. */
  listVehicleTypes() {
    return this.drivers.listActiveVehicleTypes();
  }

  /**
   * Self-service registration from the app. Reuses the single money path
   * (`DriversService.register` with source='app'): the alta is emitted as DEBT
   * and the driver stays `pending` until an admin approves. Channel rule: the 4
   * wizard steps are mandatory here, so credentials, at least one vehicle and
   * every active required document (driver + per-vehicle) must be present -
   * these obligations live in this endpoint, not in the shared register.
   * Returns a driver token so the app can upload files and submit the payment.
   */
  async register(input: CreateDriverInput, extras: RegisterInput): Promise<DriverRegisterResult> {
    const { httpErrors } = this.app;
    if (!input.nationalId || !input.password) {
      throw httpErrors.badRequest('La cédula y la clave son obligatorias');
    }
    if (extras.vehicles.length === 0) {
      throw httpErrors.badRequest('Debe registrar al menos un vehículo');
    }
    const requirements = await this.drivers.listActiveRequirements();
    const missingDriver = requirements.find(
      (r) =>
        r.appliesTo === 'driver' &&
        r.isRequired &&
        !extras.documents.some((d) => d.requirementId === r.id),
    );
    if (missingDriver) {
      throw httpErrors.badRequest(`Falta un documento obligatorio del chofer: ${missingDriver.name}`);
    }
    const vehicleRequired = requirements.filter((r) => r.appliesTo === 'vehicle' && r.isRequired);
    for (const vehicle of extras.vehicles) {
      const missing = vehicleRequired.find(
        (r) => !(vehicle.documents ?? []).some((d) => d.requirementId === r.id),
      );
      if (missing) {
        throw httpErrors.badRequest(`Falta un documento obligatorio del vehículo: ${missing.name}`);
      }
    }

    // Money path is shared and app payments are never auto-settled: force the
    // debt alta (payment:null); the payment arrives later as a submission.
    const result = await this.driversService.register(
      input,
      { ...extras, payment: null },
      null,
      { source: 'app' },
    );
    const userId = result['userId'] as string;
    const token = this.app.jwt.sign({ sub: userId, type: 'driver' });
    const driver = await this.drivers.findProfileById(userId);
    if (!driver) {
      throw httpErrors.internalServerError('No se pudo cargar el perfil del chofer recién creado');
    }
    return {
      token,
      driver,
      createdDocumentIds: result['createdDocumentIds'] as string[],
      createdVehicles: result['createdVehicles'] as { id: string; documentIds: string[] }[],
    };
  }
}
