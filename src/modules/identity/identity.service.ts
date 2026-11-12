import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { withTransaction } from '../../db/tx.js';
import {
  MAX_FILE_BYTES,
  extensionFor,
  isAllowedMimeType,
  sniffMimeType,
  type StorageProvider,
} from '../../storage/storage-provider.js';
import { writeAudit } from '../audit-logs/audit-writer.js';
import { notify } from '../notifications/notification-writer.js';
import { KIND_LABEL, IdentityPolicy, summarize, type IdentityStatus } from './identity.policy.js';
import type {
  IdentityPhotoKind,
  IdentityPhotoRecord,
  IdentityPhotoStatus,
  IdentityRepository,
} from './identity.repository.js';

/**
 * Signed links to identity photos live two minutes: a cédula is as sensitive
 * as a document, and nobody needs the link longer than it takes to look.
 */
const PHOTO_URL_TTL_SECONDS = 120;

export interface IdentityPhotoView {
  id: string;
  kind: IdentityPhotoKind;
  status: IdentityPhotoStatus;
  rejectionReason: string | null;
  uploadedAt: Date;
  reviewedAt: Date | null;
  /** Admin channel only. */
  reviewedByName?: string | null;
  url: string | null;
}

export interface IdentityView {
  status: IdentityStatus;
  /** Whether the `identity_required_enabled` switch is on (work depends on it). */
  required: boolean;
  photos: IdentityPhotoView[];
}

/**
 * Identity photos: the person sends them from the app (driver or passenger
 * channel, same rules — they belong to the person), the office reviews them in
 * the panel. Rules about what an identity ALLOWS live in IdentityPolicy.
 */
export class IdentityService {
  readonly policy: IdentityPolicy;

  constructor(
    private readonly app: FastifyInstance,
    private readonly repo: IdentityRepository,
  ) {
    this.policy = new IdentityPolicy(repo);
  }

  /** What the app shows: the person's own photos, without who reviewed them. */
  async getOwn(userId: string): Promise<IdentityView> {
    return this.view(userId, false);
  }

  async getForAdmin(userId: string): Promise<IdentityView> {
    if (!(await this.repo.userExists(userId))) {
      throw this.app.httpErrors.notFound('Persona no encontrada');
    }
    return this.view(userId, true);
  }

  /**
   * Takes one photo. Allowed when that slot is empty or its photo was rejected;
   * a photo in review or approved is final (decision by Luis, 2026-11-12: once
   * verified it cannot be changed). The selfie also becomes the profile photo.
   */
  async upload(
    userId: string,
    kind: IdentityPhotoKind,
    file: { buffer: Buffer },
  ): Promise<IdentityView> {
    const { httpErrors } = this.app;
    const storage = this.requireStorage();

    if (file.buffer.length === 0) throw httpErrors.badRequest('La foto está vacía');
    if (file.buffer.length > MAX_FILE_BYTES) {
      throw httpErrors.badRequest('La foto supera el máximo de 10 MB');
    }
    // Sniffed from the bytes, never the declared type; a PDF is not a photo.
    const sniffed = sniffMimeType(file.buffer);
    if (!sniffed || sniffed === 'application/pdf' || !isAllowedMimeType(sniffed)) {
      throw httpErrors.badRequest('Formato no admitido: solo JPG o PNG');
    }

    // Fast refusal before paying for an upload; repeated under lock below.
    this.assertReplaceable(await this.repo.currentStatus(userId, kind));

    const path = `${userId}/identity/${kind}-${randomUUID()}.${extensionFor(sniffed)}`;
    await storage.upload(path, file.buffer, sniffed);

    // Filled inside the transaction (a holder: TS does not track closure writes).
    const outcome = { photoId: '', previousProfile: null as string | null, replaced: false };
    try {
      await withTransaction(this.app.db, async (client) => {
        const current = await this.repo.lockCurrent(client, userId, kind);
        this.assertReplaceable(current?.status ?? null);
        if (current) {
          await this.repo.supersede(client, current.id);
          outcome.replaced = true;
        }
        outcome.photoId = await this.repo.insert(client, userId, kind, path);
        if (kind === 'selfie') {
          outcome.previousProfile = await this.repo.setProfilePhoto(client, userId, path);
        }
      });
    } catch (err) {
      await storage.remove(path).catch(() => {});
      // Two uploads of an empty slot racing: the unique index lets one win.
      if ((err as { code?: string }).code === '23505') {
        throw httpErrors.conflict('Ya recibimos esta foto.');
      }
      throw err;
    }

    // The free-form avatar the selfie replaces may go. An identity photo never
    // does: superseded ones are the history of what the office saw.
    const oldAvatar = outcome.previousProfile;
    if (oldAvatar && oldAvatar.startsWith(`${userId}/profile/`)) {
      await storage.remove(oldAvatar).catch(() => {});
    }

    await writeAudit(this.app.db, {
      actorUserId: userId,
      eventType: 'identity.photo_uploaded',
      entity: 'identity_photos',
      entityId: outcome.photoId,
      data: { kind, replaced: outcome.replaced },
    });
    return this.getOwn(userId);
  }

  /**
   * The office's decision on one photo. Rejecting needs the reason the person
   * will read, and may also revoke an APPROVED photo (the panel's "pedir otra
   * foto"). Under the identity rule a rejection takes the affiliate off duty.
   */
  async review(
    photoId: string,
    approve: boolean,
    reason: string | null,
    adminId: string,
  ): Promise<IdentityView> {
    const { httpErrors } = this.app;
    const photo = await this.repo.findPhoto(photoId);
    if (!photo) throw httpErrors.notFound('Foto no encontrada');
    if (photo.supersededAt) {
      throw httpErrors.conflict('La persona ya reemplazó esta foto: revisa la nueva.');
    }

    const trimmed = reason?.trim() || null;
    if (approve && photo.status === 'rejected') {
      throw httpErrors.conflict('Esta foto fue rechazada: espera a que la persona tome una nueva.');
    }
    if (approve && photo.status === 'approved') return this.getForAdmin(photo.userId);
    if (!approve && !trimmed) throw httpErrors.badRequest('Debe indicar el motivo del rechazo');
    if (!approve && photo.status === 'rejected') throw httpErrors.conflict('Esta foto ya fue rechazada.');

    await withTransaction(this.app.db, async (client) => {
      await this.repo.lockAllCurrent(client, photo.userId);
      const decided = await this.repo.review(
        client,
        photoId,
        approve ? 'approved' : 'rejected',
        approve ? null : trimmed,
        adminId,
      );
      if (!decided) throw httpErrors.conflict('La persona ya reemplazó esta foto: revisa la nueva.');

      if (approve) {
        // One notice for the whole identity, sent by the review that completes it.
        const status = summarize(await this.repo.currentPhotos(photo.userId, client));
        if (status === 'approved') await notify(client, photo.userId, { type: 'identity_verified' });
        return;
      }
      if (await this.repo.isRequired(client)) await this.repo.setUnavailable(client, photo.userId);
      await notify(
        client,
        photo.userId,
        { type: 'identity_photo_rejected', photo: KIND_LABEL[photo.kind], reason: trimmed! },
        { payload: { photoId, kind: photo.kind, reason: trimmed } },
      );
    });

    await writeAudit(this.app.db, {
      actorAdminId: adminId,
      eventType: approve ? 'identity.photo_approved' : 'identity.photo_rejected',
      entity: 'identity_photos',
      entityId: photoId,
      data: { userId: photo.userId, kind: photo.kind, ...(approve ? {} : { reason: trimmed }) },
    });
    return this.getForAdmin(photo.userId);
  }

  private assertReplaceable(status: IdentityPhotoStatus | null): void {
    if (status === 'pending') {
      throw this.app.httpErrors.conflict('Esta foto ya está en revisión.');
    }
    if (status === 'approved') {
      throw this.app.httpErrors.conflict('Esta foto ya fue verificada y no se puede cambiar.');
    }
  }

  private async view(userId: string, forAdmin: boolean): Promise<IdentityView> {
    const [photos, required] = await Promise.all([
      this.repo.currentPhotos(userId),
      this.repo.isRequired(),
    ]);
    const urls = await this.signAll(photos);
    return {
      status: summarize(photos),
      required,
      photos: photos.map((p) => ({
        id: p.id,
        kind: p.kind,
        status: p.status,
        rejectionReason: p.rejectionReason,
        uploadedAt: p.createdAt,
        reviewedAt: p.reviewedAt,
        ...(forAdmin ? { reviewedByName: p.reviewedByName } : {}),
        url: urls.get(p.filePath) ?? null,
      })),
    };
  }

  /** One round trip for all the photos; a signing failure degrades to no link. */
  private async signAll(photos: IdentityPhotoRecord[]): Promise<Map<string, string>> {
    const storage = this.app.storage;
    if (!storage || photos.length === 0) return new Map();
    return storage
      .getSignedUrls(photos.map((p) => p.filePath), PHOTO_URL_TTL_SECONDS)
      .catch(() => new Map());
  }

  private requireStorage(): StorageProvider {
    const storage = this.app.storage;
    if (!storage) throw this.app.httpErrors.serviceUnavailable('El almacenamiento no está configurado');
    return storage;
  }
}
