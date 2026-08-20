import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit-logs/audit-writer.js';
import {
  extensionFor,
  isAllowedMimeType,
  MAX_FILE_BYTES,
  sniffMimeType,
  type StorageProvider,
} from '../../storage/storage-provider.js';
import { MAX_IMAGES, type VehicleImagesRepository } from './vehicle-images.repository.js';

const SIGNED_URL_TTL_SECONDS = 60;
const UNIQUE_VIOLATION = '23505';

/**
 * Vehicle photos custody (MAX_IMAGES per vehicle). Only images (JPG/PNG) — a PDF is
 * a document, not a photo. Same storage rules as documents: private bucket,
 * content validated by magic number, path derived server-side, read via 60s
 * signed URL.
 */
export class VehicleImagesService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly images: VehicleImagesRepository,
  ) {}

  async add(
    driverId: string,
    vehicleId: string,
    file: { buffer: Buffer; mimeType: string },
    uploadedBy: string | null,
    actorUserId: string | null = null,
  ): Promise<{ id: string; position: number }> {
    const storage = this.requireStorage();
    await this.assertVehicle(driverId, vehicleId);

    if (file.buffer.length === 0) throw this.app.httpErrors.badRequest('La imagen está vacía');
    if (file.buffer.length > MAX_FILE_BYTES) {
      throw this.app.httpErrors.badRequest('La imagen supera el máximo de 10 MB');
    }
    const sniffed = sniffMimeType(file.buffer);
    if (!sniffed || sniffed === 'application/pdf' || !isAllowedMimeType(sniffed)) {
      throw this.app.httpErrors.badRequest('Formato no admitido: solo JPG o PNG');
    }

    const position = await this.images.nextPosition(vehicleId);
    if (position === null) {
      throw this.app.httpErrors.conflict(MAX_IMAGES === 1
        ? 'Solo se admite una foto por vehículo'
        : `Máximo ${MAX_IMAGES} fotos por vehículo`);
    }

    // Upload under a random key, then record it; clean the orphan on a race.
    const path = `${driverId}/vehicles/${vehicleId}/${randomUUID()}.${extensionFor(sniffed)}`;
    await storage.upload(path, file.buffer, sniffed);
    try {
      const id = await this.images.insert(vehicleId, path, position, uploadedBy);
      await writeAudit(this.app.db, {
        actorAdminId: uploadedBy,
        actorUserId,
        eventType: 'vehicle.image_added',
        entity: 'vehicles',
        entityId: vehicleId,
        data: { driverId, position },
      });
      return { id, position };
    } catch (err) {
      await storage.remove(path).catch(() => {});
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('Otra foto tomó ese lugar; reintenta');
      }
      throw err;
    }
  }

  async getFileUrl(
    driverId: string,
    vehicleId: string,
    imageId: string,
  ): Promise<{ url: string; expiresIn: number }> {
    const storage = this.requireStorage();
    await this.assertVehicle(driverId, vehicleId);
    const image = await this.images.findForVehicle(vehicleId, imageId);
    if (!image) throw this.app.httpErrors.notFound('Imagen no encontrada');
    const url = await storage.getSignedUrl(image.fileUrl, SIGNED_URL_TTL_SECONDS);
    return { url, expiresIn: SIGNED_URL_TTL_SECONDS };
  }

  async remove(driverId: string, vehicleId: string, imageId: string, adminId: string): Promise<void> {
    await this.assertVehicle(driverId, vehicleId);
    const image = await this.images.findForVehicle(vehicleId, imageId);
    if (!image) throw this.app.httpErrors.notFound('Imagen no encontrada');
    await this.images.delete(imageId);
    if (this.app.storage) {
      await this.app.storage.remove(image.fileUrl).catch((err: unknown) => {
        this.app.log.warn({ err, path: image.fileUrl }, 'failed to remove vehicle image from storage');
      });
    }
    await writeAudit(this.app.db, {
      actorAdminId: adminId,
      eventType: 'vehicle.image_removed',
      entity: 'vehicles',
      entityId: vehicleId,
      data: { driverId },
    });
  }

  private async assertVehicle(driverId: string, vehicleId: string): Promise<void> {
    if (!(await this.images.vehicleBelongsToDriver(vehicleId, driverId))) {
      throw this.app.httpErrors.notFound('Vehículo no encontrado');
    }
  }

  private requireStorage(): StorageProvider {
    if (!this.app.storage) {
      throw this.app.httpErrors.serviceUnavailable(
        'El almacenamiento de archivos no está configurado en este entorno',
      );
    }
    return this.app.storage;
  }
}
