import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit-logs/audit-writer.js';
import {
  extensionFor,
  isAllowedMimeType,
  MAX_FILE_BYTES,
  sniffMimeType,
  type StorageProvider,
} from '../../storage/storage-provider.js';
import type { BillingRepository } from './billing.repository.js';

const SIGNED_URL_TTL_SECONDS = 60;

/**
 * Invoice receipt (comprobante de pago) custody (Pieza 2). Mirrors the document
 * file flow: same private bucket, magic-number validation and short-lived
 * signed URLs. The receipt is the payer's proof (a transfer screenshot), NOT
 * the company's invoice — it attaches to the invoice as evidence of the cobro.
 */
export class BillingService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly billing: BillingRepository,
  ) {}

  async attachProof(
    invoiceId: string,
    file: { buffer: Buffer; mimeType: string },
    adminId: string,
  ): Promise<{ path: string }> {
    const storage = this.requireStorage();
    const invoice = await this.billing.findInvoiceForProof(invoiceId);
    if (!invoice) throw this.app.httpErrors.notFound('Factura no encontrada');

    if (file.buffer.length === 0) throw this.app.httpErrors.badRequest('El archivo está vacío');
    if (file.buffer.length > MAX_FILE_BYTES) {
      throw this.app.httpErrors.badRequest('El archivo supera el máximo de 10 MB');
    }

    const sniffed = sniffMimeType(file.buffer);
    if (!sniffed || !isAllowedMimeType(sniffed)) {
      throw this.app.httpErrors.badRequest('Formato no admitido: solo PDF, JPG o PNG');
    }

    // Path derived server-side; the client never chooses where it lands.
    const path = `proofs/${invoice.driverId}/${invoiceId}.${extensionFor(sniffed)}`;
    await storage.upload(path, file.buffer, sniffed);
    await this.billing.setProofUrl(invoiceId, path);

    await writeAudit(this.app.db, {
      actorAdminId: adminId,
      eventType: 'invoice.proof_uploaded',
      entity: 'invoices',
      entityId: invoiceId,
      data: { driverId: invoice.driverId, mimeType: sniffed, bytes: file.buffer.length },
    });
    return { path };
  }

  async getProofUrl(invoiceId: string): Promise<{ url: string; expiresIn: number }> {
    const storage = this.requireStorage();
    const invoice = await this.billing.findInvoiceForProof(invoiceId);
    if (!invoice) throw this.app.httpErrors.notFound('Factura no encontrada');
    if (!invoice.proofUrl) {
      throw this.app.httpErrors.notFound('Esta factura no tiene comprobante adjunto');
    }
    const url = await storage.getSignedUrl(invoice.proofUrl, SIGNED_URL_TTL_SECONDS);
    return { url, expiresIn: SIGNED_URL_TTL_SECONDS };
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
