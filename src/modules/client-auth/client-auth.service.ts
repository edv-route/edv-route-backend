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
 * rules, same signed-URL discipline — because they are the same account system
 * seen from two sides. What differs is deliberate and small: a client signs in
 * with his email OR his phone, and he needs no approval to start using the app.
 */


/** Signed-URL lifetime for the photo the app displays. */
const PHOTO_TTL_SECONDS = 3600;

/**
 * Verified against a throwaway hash when the identifier is unknown, so a
 * registered address and an unregistered one take the same time to answer.
 * Without it, the response time alone tells an attacker who has an account.
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
  address?: string | null;
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
   * Signs in with email OR phone, whichever the passenger remembers.
   *
   * The message never says which half was wrong. "Ese correo no existe" tells
   * a stranger which addresses are registered here, and that is a list worth
   * having if you are the wrong sort of person.
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
   * Creates a passenger account.
   *
   * ⚠️ The interesting case: the email or phone may already belong to somebody
   * — an AFFILIATE. That is not an error, it is the point (decision by Luis,
   * 2026-08-31): a driver who has an accident is a passenger that day. He
   * already has his `users` row, so he only gains a `clients` one, keeping his
   * name, his password and his driver side untouched.
   *
   * What IS refused is registering twice as a client.
   */
  async register(input: ClientRegisterInput): Promise<ClientLoginResult> {
    const { httpErrors } = this.app;

    if (!input.acceptedPrivacy) {
      throw httpErrors.badRequest('Debes aceptar la política de privacidad para continuar');
    }

    const phone = input.phone?.trim() || null;
    const email = input.email.trim();

    const existing = await this.clients.findUserByEmailOrPhone(email, phone);
    if (existing) {
      if (await this.clients.existsClient(existing.id)) {
        throw httpErrors.conflict(
          'Ya existe una cuenta con ese correo o teléfono. Intenta entrar en lugar de registrarte.',
        );
      }
      // Somebody the system already knows (an affiliate): give him the client
      // side without touching anything else about him.
      await this.clients.attachClientTo(existing.id);
      await writeAudit(this.app.db, {
        actorUserId: existing.id,
        eventType: 'client.attached',
        entity: 'client',
        entityId: existing.id,
        data: { reason: 'existing user registered as client' },
      });
      const profile = await this.requireProfile(existing.id);
      return { token: this.signToken(existing.id), client: profile };
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

  async getProfile(userId: string): Promise<ClientProfile> {
    return this.requireProfile(userId);
  }

  /**
   * Partial edit of his own data. Changing the password requires the current
   * one: a stolen session must not be enough to lock the owner out.
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

    // Email and phone are identifiers: both are unique, and both are how he
    // gets back in. A collision has to say so instead of failing on a
    // constraint the app cannot explain.
    if (input.email !== undefined || input.phone !== undefined) {
      const email = (input.email ?? record.email ?? '').trim();
      const phone = input.phone !== undefined ? input.phone?.trim() || null : record.phone;
      const clash = await this.clients.findUserByEmailOrPhone(email, phone);
      if (clash && clash.id !== userId) {
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
   * Replaces the profile photo. Same rules as the driver's, and they are not
   * decoration: the content is sniffed rather than trusted (a .png that is
   * really a PDF is rejected), it lands in the PRIVATE bucket, and only its
   * path is stored.
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
      // The row did not change, so the object would be an orphan.
      await storage.remove(path).catch(() => {});
      throw err;
    }
    // Best effort: an orphan object costs storage, a failed request costs him
    // his new photo. The new path is already committed.
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

  /**
   * Turns the stored bucket path into a signed URL before the profile leaves
   * the API. `photo_url` holds a PATH, never a public link. A signing failure
   * degrades to no photo — the app falls back to initials — rather than failing
   * the whole request.
   */
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
