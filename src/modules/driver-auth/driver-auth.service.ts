import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { writeAudit } from '../audit-logs/audit-writer.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import { MAX_APP_ADVANCE_WEEKS } from '../payment-submissions/payment-submissions.service.js';
import {
  MAX_FILE_BYTES,
  extensionFor,
  isAllowedMimeType,
  sniffMimeType,
} from '../../storage/storage-provider.js';
import type { FastifyInstance } from 'fastify';
import { DriversService } from '../drivers/drivers.service.js';
import type { DriversRepository } from '../drivers/drivers.repository.js';
import type { CreateDriverInput } from '../drivers/drivers.service.js';
import type {
  AppUpcomingCharge,
  AppVehicleRow,
  DriverAuthRepository,
  DriverProfile,
} from './driver-auth.repository.js';

// Verified against when the national id is unknown or has no app password, so
// both paths cost the same time (prevents user enumeration via response timing).
const DUMMY_HASH_PROMISE = argon2.hash('timing-equalizer-dummy-password');

const UNIQUE_VIOLATION = '23505';

/**
 * Statuses that may take work. `overdue` is deliberately in: he owes weeks but
 * is under the tolerance cap, so he keeps operating (debt engine, decision
 * 2026-07-23). `penalized` and `paused` are out.
 */
const CAN_OPERATE_STATUSES = ['approved', 'overdue'];

/** Vehicle photo signed URLs are short-lived: enough to view, not to share. */
const VEHICLE_IMAGE_TTL_SECONDS = 60;

/**
 * Avatars get a MUCH longer TTL than documents (1 h vs 60 s) on purpose: they
 * are rendered in every list and the client caches them by URL, so a short TTL
 * would mean re-downloading the same face on every scroll. A face is far less
 * sensitive than an identity document, and the bucket stays private either way.
 */
const AVATAR_TTL_SECONDS = 3600;

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
  /** The one he is operating with; only one vehicle can hold it. */
  isPrimary: boolean;
  images: AppVehicleImage[];
}

/**
 * The driver's account standing, as his own profile consumes it. `upcoming` and
 * `nextChargeAt` are mutually exclusive by construction: either the next weekly
 * charge is already emitted (and payable in advance), or it is not, and then we
 * know WHEN the engine will emit it.
 */
export interface AppAccount {
  /** Authoritative standing: the drivers.status the debt engine maintains. */
  driverStatus: string;
  /** Penalized-but-settled: when the engine lets him operate again. */
  reactivatesAt: string | null;
  /**
   * His start is PROGRAMMED for this date and hasn't arrived yet. Null once the
   * tariff is running. Without it the app could only tell him he was not enabled,
   * never that he already has a date.
   */
  tariffStartsAt: string | null;
  /** End of the last prepaid week: until when he is covered. Null if never paid. */
  paidUntil: string | null;
  upcoming: AppUpcomingCharge | null;
  /** When the engine will EMIT the next weekly charge (weekly active plans only). */
  nextChargeAt: string | null;
  weeksOwed: number;
  penaltyCount: number;
  /** Weeks of arrears tolerated before penalizing (app_settings). */
  capWeeks: number;
  planPriceUsd: string | null;
  /**
   * Unread notices for the bell. It travels HERE, inside a call the app already
   * makes on every screen, and never in a request of its own: a second call that
   * fails without a signal leaves the badge showing a stale number while the
   * rest of the screen is fresh (that is exactly how the "vehículo en uso" bug
   * behaved).
   */
  unreadNotifications: number;
  /**
   * Weeks he may prepay from the app. Sent by the server so the wheel can never
   * offer a number the backend would refuse — the app must not carry its own
   * copy of a business limit.
   */
  maxAdvanceWeeks: number;
}

/** What a driver may change about himself (see updateOwnProfile). */
export interface SelfProfileInput {
  phone?: string;
  email?: string;
  address?: string;
  /** New password; requires `currentPassword` to prove ownership. */
  password?: string;
  currentPassword?: string;
}

export class DriverAuthService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly drivers: DriverAuthRepository,
    private readonly driversService: DriversService,
    /** Admin-channel repository: the account view reuses its billing helpers. */
    private readonly driversRepository: DriversRepository,
    /** Only for the unread badge that rides inside the account standing. */
    private readonly notifications: NotificationsRepository,
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
    return { token, driver: await this.withSignedPhoto(driver) };
  }

  async getProfile(userId: string): Promise<DriverProfile> {
    const driver = await this.drivers.findProfileById(userId);
    if (!driver) {
      throw this.app.httpErrors.unauthorized('Sesión inválida');
    }
    return this.withSignedPhoto(driver);
  }

  /**
   * Turns the stored bucket path into a signed URL before the profile leaves the
   * API. `photo_url` holds a PATH, never a public link — a client that could
   * read the bucket directly would defeat the private-bucket rule. A signing
   * failure degrades to no photo (the UI falls back to initials) instead of
   * breaking login.
   */
  private async withSignedPhoto<T extends { photoUrl: string | null }>(driver: T): Promise<T> {
    const storage = this.app.storage;
    if (!driver.photoUrl || !storage) return { ...driver, photoUrl: null };
    const url = await storage
      .getSignedUrl(driver.photoUrl, AVATAR_TTL_SECONDS)
      .catch(() => null);
    return { ...driver, photoUrl: url };
  }

  /**
   * Replaces the driver's profile photo. Only real JPG/PNG pass (magic-number
   * sniffed, never the declared type), the object lands under a random key in
   * the private bucket, and the previous one is deleted so a driver cannot
   * accumulate orphan files by re-uploading.
   */
  async replacePhoto(
    userId: string,
    file: { buffer: Buffer; mimeType: string },
  ): Promise<{ photoUrl: string | null }> {
    const { httpErrors } = this.app;
    const storage = this.app.storage;
    if (!storage) throw httpErrors.serviceUnavailable('El almacenamiento no está configurado');

    if (file.buffer.length === 0) throw httpErrors.badRequest('La imagen está vacía');
    if (file.buffer.length > MAX_FILE_BYTES) {
      throw httpErrors.badRequest('La imagen supera el máximo de 10 MB');
    }
    const sniffed = sniffMimeType(file.buffer);
    if (!sniffed || sniffed === 'application/pdf' || !isAllowedMimeType(sniffed)) {
      throw httpErrors.badRequest('Formato no admitido: solo JPG o PNG');
    }

    const path = `${userId}/profile/${randomUUID()}.${extensionFor(sniffed)}`;
    await storage.upload(path, file.buffer, sniffed);

    let previous: string | null;
    try {
      previous = await this.drivers.replacePhotoPath(userId, path);
    } catch (err) {
      await storage.remove(path).catch(() => {});
      throw err;
    }
    // Best effort: an orphan object costs storage, a failed request costs the
    // driver his new photo. The new path is already committed.
    if (previous && previous !== path) await storage.remove(previous).catch(() => {});

    await writeAudit(this.app.db, {
      actorUserId: userId,
      eventType: 'driver.photo_updated',
      entity: 'users',
      entityId: userId,
    });

    const url = await storage.getSignedUrl(path, AVATAR_TTL_SECONDS).catch(() => null);
    return { photoUrl: url };
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
          isPrimary: v.isPrimary,
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
   * Picks which of his vehicles he is operating with. Choosing one releases the
   * previous automatically (a single column holds the answer).
   *
   * Only an APPROVED vehicle can be chosen: one under review or rejected has not
   * passed the document check, and letting him work with it would make that
   * review pointless.
   */
  async setPrimaryVehicle(userId: string, vehicleId: string): Promise<{ id: string }> {
    const { httpErrors } = this.app;
    const vehicle = await this.drivers.findOwnVehicle(userId, vehicleId);
    if (!vehicle) throw httpErrors.notFound('Ese vehículo no es tuyo');
    if (vehicle.approvalStatus !== 'approved') {
      throw httpErrors.conflict(
        vehicle.approvalStatus === 'rejected'
          ? 'Ese vehículo fue rechazado. Corrige lo indicado para poder usarlo.'
          : 'Ese vehículo todavía está en revisión. Podrás usarlo cuando lo aprueben.',
      );
    }

    await this.drivers.setPrimaryVehicle(userId, vehicleId);
    await writeAudit(this.app.db, {
      actorUserId: userId,
      eventType: 'driver.primary_vehicle_changed',
      entity: 'vehicles',
      entityId: vehicleId,
      data: { driverId: userId },
    });
    return { id: vehicleId };
  }

  /**
   * The driver marks himself available (or not) for work. Going OFF is always
   * allowed — he may stop for the day whenever he wants. Going ON is gated by
   * the same rule the app shows him: only an affiliate who may operate can take
   * work, so a penalized or paused driver cannot put himself back on the road by
   * flipping a switch. This is the first real consumer of that rule.
   */
  async setAvailability(userId: string, available: boolean): Promise<{ isAvailable: boolean }> {
    const { httpErrors } = this.app;
    const status = await this.drivers.findStatus(userId);
    if (!status) throw httpErrors.notFound('No se encontró tu perfil');

    if (available && !CAN_OPERATE_STATUSES.includes(status)) {
      throw httpErrors.conflict(await this.cannotGoActiveReason(userId, status));
    }

    const isAvailable = await this.drivers.setAvailability(userId, available);
    if (isAvailable === null) throw httpErrors.notFound('No se encontró tu perfil');

    await writeAudit(this.app.db, {
      actorUserId: userId,
      eventType: 'driver.availability_changed',
      entity: 'drivers',
      entityId: userId,
      data: { isAvailable },
    });
    return { isAvailable };
  }

  /**
   * Why he cannot go active, said in a way he can act on (2026-08-20).
   *
   * It used to answer "tu cuenta no está habilitada para trabajar, contacta a la
   * oficina" to everyone, which is a dead end — and plainly wrong for the most
   * common case: a driver whose start the admin already PROGRAMMED. He is not
   * blocked, he is early, and there is a date to tell him.
   */
  private async cannotGoActiveReason(userId: string, status: string): Promise<string> {
    if (status === 'penalized') {
      return 'No puedes ponerte activo mientras estés penalizado. Paga lo que debes para volver a operar.';
    }
    if (status === 'paused') {
      return 'Tu cuenta está en pausa. Contacta a la oficina para reanudarla.';
    }
    if (status === 'scheduled') {
      const { rows } = await this.app.db.query<{ startsOn: string | null }>(
        `SELECT to_char(ds.current_period_start AT TIME ZONE
                  COALESCE((SELECT value #>> '{}' FROM app_settings WHERE key = 'business_timezone'),
                           'America/Caracas'),
                'DD/MM/YYYY') AS "startsOn"
           FROM driver_subscriptions ds
          WHERE ds.driver_id = $1 AND ds.status = 'scheduled'
          ORDER BY ds.created_at DESC LIMIT 1`,
        [userId],
      );
      const startsOn = rows[0]?.startsOn;
      return startsOn
        ? `Tu tarifa arranca el ${startsOn}. Ese día podrás ponerte activo.`
        : 'Tu inicio ya está programado. Podrás ponerte activo cuando arranque tu tarifa.';
    }
    return 'Tu cuenta no está habilitada para trabajar. Contacta a la oficina.';
  }

  /** Address prefill for the app's edit form (the rest already travels in /me). */
  async getEditableData(userId: string): Promise<{ address: string | null }> {
    const data = await this.drivers.findEditableData(userId);
    if (!data) throw this.app.httpErrors.notFound('No se encontró tu perfil');
    return data;
  }

  /**
   * Self-service edit of the driver's OWN data. The whitelist is deliberately
   * short — phone, email, address and password — because names and national id
   * are the identity an admin verified against approved documents; letting the
   * driver rewrite them would invalidate that review without anyone noticing.
   * Changing the password re-authenticates first (OWASP): a stolen session must
   * not be enough to lock the real owner out of his account.
   */
  async updateOwnProfile(userId: string, input: SelfProfileInput): Promise<DriverProfile> {
    const { httpErrors } = this.app;
    const changes: Parameters<DriverAuthRepository['updateOwnProfile']>[1] = {};

    if (input.phone !== undefined) changes.phone = input.phone.trim() || null;
    if (input.address !== undefined) changes.address = input.address.trim() || null;
    if (input.email !== undefined) changes.email = input.email.trim() || null;

    if (input.password !== undefined) {
      if (!input.currentPassword) {
        throw httpErrors.badRequest('Para cambiar la clave debes escribir la clave actual');
      }
      const hash = await this.drivers.findPasswordHash(userId);
      const valid = hash ? await argon2.verify(hash, input.currentPassword).catch(() => false) : false;
      if (!valid) throw httpErrors.unauthorized('La clave actual no es correcta');
      changes.passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    }

    if (Object.keys(changes).length === 0) {
      throw httpErrors.badRequest('No enviaste ningún dato para actualizar');
    }

    try {
      await this.drivers.updateOwnProfile(userId, changes);
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw httpErrors.conflict('Ese correo ya está registrado por otra persona');
      }
      throw err;
    }

    await writeAudit(this.app.db, {
      actorUserId: userId,
      eventType: 'driver.self_updated',
      entity: 'users',
      entityId: userId,
      // The new values are NOT logged: an audit trail must not become a second
      // copy of personal data. Which fields moved is enough to trace the change.
      data: { fields: Object.keys(changes) },
    });

    const profile = await this.drivers.findProfileById(userId);
    if (!profile) throw httpErrors.notFound('No se encontró tu perfil');
    return this.withSignedPhoto(profile);
  }

  /**
   * Account standing for the driver's own profile: coverage, next charge and
   * arrears. Mirrors what the admin sees in the affiliate detail, so the app and
   * the panel can never disagree about whether he is up to date.
   */
  async getAccount(userId: string): Promise<AppAccount> {
    const row = await this.drivers.getAccount(userId);
    if (!row) throw this.app.httpErrors.notFound('No se encontró tu cuenta');

    // Only a WEEKLY and ACTIVE tariff has a scheduled emission: the same gate
    // the panel applies (drivers.service.getDetail). Without it the profile
    // would print a weekly cobro date to a driver whose plan is not weekly.
    const nextChargeAt =
      row.billingPeriod === 'weekly' && row.subscriptionStatus === 'active'
        ? await this.driversRepository.weeklyNextChargeAt(userId)
        : null;

    return {
      driverStatus: row.driverStatus,
      reactivatesAt: toIsoDate(row.reactivatesAt),
      tariffStartsAt: toIsoDate(row.tariffStartsAt),
      paidUntil: toIsoDate(row.paidUntil),
      upcoming: row.upcoming,
      nextChargeAt,
      weeksOwed: row.weeksOwed,
      penaltyCount: row.penaltyCount,
      capWeeks: row.capWeeks,
      planPriceUsd: row.planPriceUsd,
      unreadNotifications: await this.notifications.unreadCount(userId),
      maxAdvanceWeeks: MAX_APP_ADVANCE_WEEKS,
    };
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

/** pg hands timestamps back as Date; the app speaks ISO strings only. */
function toIsoDate(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
