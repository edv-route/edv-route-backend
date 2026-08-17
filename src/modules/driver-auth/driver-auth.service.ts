import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { DriversService } from '../drivers/drivers.service.js';
import type { CreateDriverInput } from '../drivers/drivers.service.js';
import type { AppVehicleRow, DriverAuthRepository, DriverProfile } from './driver-auth.repository.js';

// Verified against when the national id is unknown or has no app password, so
// both paths cost the same time (prevents user enumeration via response timing).
const DUMMY_HASH_PROMISE = argon2.hash('timing-equalizer-dummy-password');

/** Vehicle photo signed URLs are short-lived: enough to view, not to share. */
const VEHICLE_IMAGE_TTL_SECONDS = 60;

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

/** A vehicle photo with a short-lived signed URL, as the app consumes it. */
export interface AppVehicleImage {
  id: string;
  position: number;
  url: string;
}

/** A driver's vehicle for the profile: full detail + signed photo URLs. */
export interface AppVehicle {
  id: string;
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  plate: string | null;
  vehicleType: string | null;
  approvalStatus: string;
  rejectionReason: string | null;
  images: AppVehicleImage[];
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

  /**
   * The driver's vehicles for the profile, with each photo resolved to a
   * short-lived signed URL (the bucket is private, so paths never leave the API).
   */
  async getVehicles(driverId: string): Promise<AppVehicle[]> {
    const storage = this.app.storage;
    const rows = await this.drivers.getVehicles(driverId);
    return Promise.all(
      rows.map(async (v: AppVehicleRow): Promise<AppVehicle> => {
        const images: AppVehicleImage[] = [];
        if (storage) {
          for (const img of v.images) {
            const url = await storage.getSignedUrl(img.fileUrl, VEHICLE_IMAGE_TTL_SECONDS);
            images.push({ id: img.id, position: img.position, url });
          }
        }
        return {
          id: v.id,
          brand: v.brand,
          model: v.model,
          year: v.year,
          color: v.color,
          plate: v.plate,
          vehicleType: v.vehicleType,
          approvalStatus: v.approvalStatus,
          rejectionReason: v.rejectionReason,
          images,
        };
      }),
    );
  }

  /**
   * Gate before a payment submission (proposal: solicitudes-app): an `applicant`
   * cannot pay yet (his solicitud is not approved), and paying requires accepting
   * the terms & conditions — stamps accepted_terms_at.
   */
  async assertPayableAndAcceptTerms(userId: string, acceptedTerms: boolean): Promise<void> {
    const { httpErrors } = this.app;
    const profile = await this.drivers.findProfileById(userId);
    if (!profile) throw httpErrors.unauthorized('Sesión inválida');
    if (profile.status === 'applicant') {
      throw httpErrors.conflict(
        'Tu solicitud aún no ha sido aprobada; no puedes registrar el pago todavía',
      );
    }
    if (!acceptedTerms) {
      throw httpErrors.badRequest('Debe aceptar los términos y condiciones para pagar');
    }
    await this.drivers.markTermsAccepted(userId);
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

  /** Current active membership (name + price) for the alta summary; null if none. */
  getCurrentMembership() {
    return this.drivers.getCurrentMembership();
  }

  /** Active tariffs for the alta summary (the app charges the weekly one). */
  listActivePlans() {
    return this.drivers.listActivePlans();
  }

  /** "Completa tu solicitud" checklist for the authenticated applicant. */
  getChecklist(userId: string) {
    return this.drivers.getChecklist(userId);
  }

  /** The driver's current alta/arrears debt (for the app's deferred payment). */
  getDebt(userId: string) {
    return this.drivers.getDebt(userId);
  }

  /**
   * Self-service registration from the app — STEP 1 ONLY (proposal:
   * docs/proposals/solicitudes-app). Creates the identity + driver as an
   * `applicant` (a solicitud, NOT an affiliate): no documents, no vehicle, no
   * money. Documents and vehicles are added afterwards from the app; an admin
   * reviews them and, on approving the solicitud, the driver is promoted to
   * `approved` WITH his base debt. Privacy consent is captured here. Returns a
   * driver token so the app can log in and complete the solicitud.
   */
  async register(input: CreateDriverInput, acceptedPrivacy: boolean): Promise<DriverRegisterResult> {
    const { httpErrors } = this.app;
    if (!input.nationalId || !input.password) {
      throw httpErrors.badRequest('La cédula y la clave son obligatorias');
    }
    if (!acceptedPrivacy) {
      throw httpErrors.badRequest('Debe aceptar la política de privacidad para continuar');
    }

    // Reduced alta: no money (deferred), no children. The driver is born
    // `applicant`; documents/vehicles come next from the app and the admin
    // approves the solicitud, which is what emits the base debt.
    const result = await this.driversService.register(
      input,
      { payment: null, vehicles: [], documents: [], deferredEnrollment: true },
      null,
      { source: 'app', initialStatus: 'applicant', acceptedPrivacy: true },
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
