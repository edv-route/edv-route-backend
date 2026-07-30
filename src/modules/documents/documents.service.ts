import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit-logs/audit-writer.js';
import {
  extensionFor,
  isAllowedMimeType,
  MAX_FILE_BYTES,
  sniffMimeType,
  type StorageProvider,
} from '../../storage/storage-provider.js';
import type { SettingsRepository } from '../settings/settings.repository.js';
import type {
  DocumentsRepository,
  DocumentListFilters,
  DocumentListResult,
} from './documents.repository.js';

/** Signed URLs are short-lived: enough to open the file, not to share it. */
const SIGNED_URL_TTL_SECONDS = 60;

/**
 * Cross-cutting document view + file custody. Document records are created
 * from the driver profile/wizard (drivers module); expiry transitions belong
 * to the document scheduler. Expired documents alert the panel but do NOT
 * block the driver's operation (design v7 - blocking would be a new rule).
 */
export class DocumentsService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly documents: DocumentsRepository,
    private readonly settings: SettingsRepository,
  ) {}

  async list(filters: Omit<DocumentListFilters, 'timezone'>): Promise<DocumentListResult> {
    const timezone = await this.settings.get('business_timezone', 'America/Caracas');
    return this.documents.list({ ...filters, timezone: String(timezone) });
  }

  /**
   * Stores the file and links it to the document record. The MIME type is
   * validated against the sniffed content, never trusting the client's
   * declared type or filename.
   */
  async attachFile(
    documentId: string,
    file: { buffer: Buffer; mimeType: string },
    adminId: string,
  ): Promise<{ path: string }> {
    const storage = this.requireStorage();
    const document = await this.requireDocument(documentId);

    if (file.buffer.length === 0) throw this.app.httpErrors.badRequest('El archivo está vacío');
    if (file.buffer.length > MAX_FILE_BYTES) {
      throw this.app.httpErrors.badRequest('El archivo supera el máximo de 10 MB');
    }

    const sniffed = sniffMimeType(file.buffer);
    if (!sniffed || !isAllowedMimeType(sniffed)) {
      throw this.app.httpErrors.badRequest('Formato no admitido: solo PDF, JPG o PNG');
    }
    if (sniffed !== file.mimeType) {
      this.app.log.warn(
        { declared: file.mimeType, actual: sniffed, documentId },
        'declared content-type does not match file contents',
      );
    }

    // Path derived server-side: the client never chooses where it lands.
    const path = `${document.driverId}/${documentId}.${extensionFor(sniffed)}`;
    await storage.upload(path, file.buffer, sniffed);
    await this.documents.setFileUrl(documentId, path);

    await writeAudit(this.app.db, {
      actorAdminId: adminId,
      eventType: 'document.file_uploaded',
      entity: 'documents',
      entityId: documentId,
      data: { driverId: document.driverId, mimeType: sniffed, bytes: file.buffer.length },
    });
    return { path };
  }

  /** Time-limited link; the bucket is private and never served publicly. */
  async getFileUrl(documentId: string): Promise<{ url: string; expiresIn: number }> {
    const storage = this.requireStorage();
    const document = await this.requireDocument(documentId);
    if (!document.fileUrl) {
      throw this.app.httpErrors.notFound('Este documento no tiene archivo adjunto');
    }
    const url = await storage.getSignedUrl(document.fileUrl, SIGNED_URL_TTL_SECONDS);
    return { url, expiresIn: SIGNED_URL_TTL_SECONDS };
  }

  /** Removes a document record and its stored file (best-effort on the file). */
  async deleteDocument(documentId: string, adminId: string): Promise<void> {
    const document = await this.requireDocument(documentId);
    await this.documents.delete(documentId);
    if (document.fileUrl && this.app.storage) {
      await this.app.storage.remove(document.fileUrl).catch((err: unknown) => {
        this.app.log.warn(
          { err, path: document.fileUrl },
          'failed to remove document file from storage',
        );
      });
    }
    await writeAudit(this.app.db, {
      actorAdminId: adminId,
      eventType: 'document.deleted',
      entity: 'documents',
      entityId: documentId,
      data: { driverId: document.driverId },
    });
  }

  private requireStorage(): StorageProvider {
    if (!this.app.storage) {
      throw this.app.httpErrors.serviceUnavailable(
        'El almacenamiento de archivos no está configurado en este entorno',
      );
    }
    return this.app.storage;
  }

  private async requireDocument(
    id: string,
  ): Promise<{ id: string; driverId: string; fileUrl: string | null }> {
    const document = await this.documents.findOwner(id);
    if (!document) throw this.app.httpErrors.notFound('Documento no encontrado');
    return document;
  }
}
