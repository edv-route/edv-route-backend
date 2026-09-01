import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit-logs/audit-writer.js';
import {
  MAX_FILE_BYTES,
  extensionFor,
  isAllowedMimeType,
  sniffMimeType,
} from '../../storage/storage-provider.js';
import type { ClientAuthRepository, ClientProfile } from './client-auth.repository.js';

/**
 * The passenger side of the account (proposal: docs/proposals/cliente).
 *
 * Mirrors `DriverAuthService` on purpose — same password hashing, same photo
 * rules, same signed-URL discipline. Since 2026-09-01 the roles are
 * INDEPENDENT (decision by Luis): this role owns its email, phone and
 * password on `clients`; the person (names, cédula, birth date) is shared.
 *
 * Registration is cédula-FIRST: `checkCedula` says which form the app shows —
 * full (new person) or short (an existing person gaining the client hat, who
 * must prove it is him with the password he already has).
 */

/** Signed-URL lifetime for the photo the app displays. */
const PHOTO_TTL_SECONDS = 3600;

/**
 * Verified against a throwaway hash when the identifier is unknown, so a
 * registered address and an unregistered one take the same time to answer.
 */
const DUMMY_HASH_PROMISE = argon2.hash('timing-equalizer-dummy-password');

export interface ClientRegisterInput {
  firstName: string;
  middleName?: string | null;
  lastName: string;
  secondLastName?: string | null;
  email: string;
  phone?: string | null;
  birthDate?: string | null;
  nationalId?: string | null;
  address?: string | null;
  password: string;
  acceptedPrivacy: boolean;
}

/** The SHORT form: an existing person gains the client hat (Luis, 2026-09-01). */
export interface ClientAttachInput {
  nationalId: string;
  /** The password the account ALREADY has — the proof it is him. */
  currentPassword: string;
  email: string;
  phone?: string | null;
  /** This role's own password (same or different, his call). */
  password: string;
  acceptedPrivacy: boolean;
}

export interface ClientLoginResult {
  token: string;
  client: ClientProfile;
}

export class ClientAuthService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly clients: ClientAuthRepository,
  ) {}

  /**
   * Signs in with email OR phone, whichever the passenger remembers — HIS
   * client ones. The message never says which half was wrong.
   */
  async login(identifier: string, password: string): Promise<ClientLoginResult> {
    const { httpErrors } = this.app;
    const record = await this.clients.findAuthByIdentifier(identifier.trim());

    if (!record?.passwordHash) {
      await argon2.verify(await DUMMY_HASH_PROMISE, password).catch(() => false);
      throw httpErrors.unauthorized('Datos incorrectos');
    }
    if (!(await argon2.verify(record.passwordHash, password))) {
      throw httpErrors.unauthorized('Datos incorrectos');
    }
    if (record.status === 'suspended') {
      throw httpErrors.forbidden('Tu cuenta está suspendida. Comunícate con la oficina.');
    }

    const { passwordHash: _hash, ...client } = record;
    return { token: this.signToken(record.userId), client: await this.withSignedPhoto(client) };
  }

  /**
   * Step 0 of the registration: which form does this cédula deserve?
   * `new` (full form) · `attachable` (short form) · `exists` (go log in).
   * Confirming existence per cédula is assumed enumeration, same criterion as
   * the register message (decisions-log 2026-08-31).
   */
  async checkCedula(nationalId: string): Promise<{ status: 'new' | 'attachable' | 'exists' }> {
    const person = await this.clients.findPersonByCedula(nationalId.trim());
    if (!person) return { status: 'new' };
    return { status: person.hasClient ? 'exists' : 'attachable' };
  }

  /**
   * FULL registration: a brand-new person. The role's email/phone/password
   * land on `clients`; the person on `users`. A cédula somebody else holds —
   * on either side — is refused before anything is written.
   */
  async register(input: ClientRegisterInput): Promise<ClientLoginResult> {
    const { httpErrors } = this.app;

    if (!input.acceptedPrivacy) {
      throw httpErrors.badRequest('Debes aceptar la política de privacidad para continuar');
    }

    const phone = input.phone?.trim() || null;
    const email = input.email.trim();
    const nationalId = input.nationalId?.trim() || null;

    if (nationalId && (await this.clients.cedulaTakenByOther(nationalId, null))) {
      throw httpErrors.conflict(
        'Esa cédula ya tiene una cuenta. Vuelve atrás y escribe tu cédula para continuar con ella.',
      );
    }
    if (await this.clients.contactTakenByOtherClient(email, phone, null)) {
      throw httpErrors.conflict('Ese correo o teléfono ya pertenece a otro cliente.');
    }

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const userId = await this.clients.createClient({
      firstName: input.firstName.trim(),
      middleName: input.middleName?.trim() || null,
      lastName: input.lastName.trim(),
      secondLastName: input.secondLastName?.trim() || null,
      fullName: fullNameOf(input),
      email,
      phone,
      birthDate: input.birthDate ?? null,
      address: input.address?.trim() || null,
      nationalId,
      passwordHash,
    });

    await writeAudit(this.app.db, {
      actorUserId: userId,
      eventType: 'client.registered',
      entity: 'client',
      entityId: userId,
    });

    return { token: this.signToken(userId), client: await this.requireProfile(userId) };
  }

  /**
   * SHORT registration: the person exists (found by cédula) and gains the
   * client hat. The proof of ownership is the password the account already
   * has — without it, knowing a cédula would be enough to take over an
   * affiliate's account. Every refusal on the proof answers the same message.
   */
  async attach(input: ClientAttachInput): Promise<ClientLoginResult> {
    const { httpErrors } = this.app;

    if (!input.acceptedPrivacy) {
      throw httpErrors.badRequest('Debes aceptar la política de privacidad para continuar');
    }

    const notAttachable = httpErrors.conflict(
      'Los datos no coinciden con una cuenta que pueda hacerse cliente. Revisa tu cédula y tu clave.',
    );
    const person = await this.clients.findPersonByCedula(input.nationalId.trim());
    if (!person || person.hasClient) {
      await argon2.verify(await DUMMY_HASH_PROMISE, input.currentPassword).catch(() => false);
      throw notAttachable;
    }
    const ok = person.driverPasswordHash
      ? await argon2.verify(person.driverPasswordHash, input.currentPassword).catch(() => false)
      : false;
    if (!ok) throw notAttachable;

    const email = input.email.trim();
    const phone = input.phone?.trim() || null;
    if (await this.clients.contactTakenByOtherClient(email, phone, person.id)) {
      // Only the legitimate owner reaches here, so this one speaks plainly.
      throw httpErrors.conflict('Ese correo o teléfono ya pertenece a otro cliente.');
    }

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    await this.clients.attachClientTo(person.id, { email, phone, passwordHash });
    await writeAudit(this.app.db, {
      actorUserId: person.id,
      eventType: 'client.attached',
      entity: 'client',
      entityId: person.id,
      data: { reason: 'existing user registered as client (password verified)' },
    });
    return { token: this.signToken(person.id), client: await this.requireProfile(person.id) };
  }

  async getProfile(userId: string): Promise<ClientProfile> {
    return this.requireProfile(userId);
  }

  /**
   * Partial edit of his own data. Names/birth/address touch the PERSON
   * (shared with the driver side, decision by Luis: one name for both hats);
   * email/phone/password touch only THIS role. Changing the password requires
   * the current one.
   */
  async updateProfile(
    userId: string,
    input: Partial<ClientRegisterInput> & { currentPassword?: string },
  ): Promise<ClientProfile> {
    const { httpErrors } = this.app;

    const record = await this.clients.findProfileById(userId);
    if (!record) throw httpErrors.unauthorized('Sesión inválida');

    const changes: Parameters<ClientAuthRepository['updateProfile']>[1] = {};

    if (input.firstName !== undefined) changes.firstName = input.firstName.trim();
    if (input.middleName !== undefined) changes.middleName = input.middleName?.trim() || null;
    if (input.lastName !== undefined) changes.lastName = input.lastName.trim();
    if (input.secondLastName !== undefined) {
      changes.secondLastName = input.secondLastName?.trim() || null;
    }
    if (input.birthDate !== undefined) changes.birthDate = input.birthDate ?? null;
    if (input.address !== undefined) changes.address = input.address?.trim() || null;

    // Email and phone are THIS role's identifiers: unique among clients. A
    // collision has to say so instead of failing on a constraint.
    if (input.email !== undefined || input.phone !== undefined) {
      const email = (input.email ?? record.email ?? '').trim();
      const phone = input.phone !== undefined ? input.phone?.trim() || null : record.phone;
      if (await this.clients.contactTakenByOtherClient(email, phone, userId)) {
        throw httpErrors.conflict('Ese correo o teléfono ya pertenece a otra cuenta');
      }
      if (input.email !== undefined) changes.email = email;
      if (input.phone !== undefined) changes.phone = phone;
    }

    if (
      changes.firstName !== undefined ||
      changes.middleName !== undefined ||
      changes.lastName !== undefined ||
      changes.secondLastName !== undefined
    ) {
      changes.fullName = fullNameOf({
        firstName: changes.firstName ?? record.firstName,
        middleName: changes.middleName ?? record.middleName,
        lastName: changes.lastName ?? record.lastName,
        secondLastName: changes.secondLastName ?? record.secondLastName,
      });
    }

    if (input.password !== undefined) {
      const storedHash = await this.clients.findPasswordHash(userId);
      if (!input.currentPassword || !storedHash) {
        throw httpErrors.badRequest('Para cambiar la clave debes escribir la actual');
      }
      if (!(await argon2.verify(storedHash, input.currentPassword))) {
        throw httpErrors.badRequest('La clave actual no es correcta');
      }
      changes.passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    }

    await this.clients.updateProfile(userId, changes);
    return this.requireProfile(userId);
  }

  /**
   * Replaces the profile photo. Same rules as the driver's: the content is
   * sniffed rather than trusted, it lands in the PRIVATE bucket, and only its
   * path is stored. The photo is the PERSON's (shared by both hats).
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
      previous = await this.clients.setPhotoPath(userId, path);
    } catch (err) {
      await storage.remove(path).catch(() => {});
      throw err;
    }
    if (previous && previous !== path) await storage.remove(previous).catch(() => {});

    const signed = await storage.getSignedUrls([path], PHOTO_TTL_SECONDS).catch(() => new Map());
    return { photoUrl: signed.get(path) ?? null };
  }

  private signToken(userId: string): string {
    return this.app.jwt.sign(
      { sub: userId, type: 'client' },
      { expiresIn: this.app.config.DRIVER_JWT_EXPIRES_IN },
    );
  }

  private async requireProfile(userId: string): Promise<ClientProfile> {
    const profile = await this.clients.findProfileById(userId);
    if (!profile) throw this.app.httpErrors.unauthorized('Sesión inválida');
    return this.withSignedPhoto(profile);
  }

  private async withSignedPhoto(profile: ClientProfile): Promise<ClientProfile> {
    const storage = this.app.storage;
    if (!storage || !profile.photoUrl) return { ...profile, photoUrl: null };
    const signed = await storage
      .getSignedUrls([profile.photoUrl], PHOTO_TTL_SECONDS)
      .catch(() => new Map<string, string>());
    return { ...profile, photoUrl: signed.get(profile.photoUrl) ?? null };
  }
}

/** "Luis David Villegas Vargas" from its parts, skipping the empty ones. */
function fullNameOf(person: {
  firstName: string;
  middleName?: string | null;
  lastName: string;
  secondLastName?: string | null;
}): string {
  return [person.firstName, person.middleName, person.lastName, person.secondLastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ');
}
