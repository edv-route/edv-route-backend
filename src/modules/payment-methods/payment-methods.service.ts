import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit-logs/audit-writer.js';
import type {
  PaymentMethodRecord,
  PaymentMethodsRepository,
  UpdatePaymentMethodData,
} from './payment-methods.repository.js';

const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Required `details` fields per payment method type (camelCase, as they travel
 * in the API). Extra keys are allowed (e.g. crypto `qrUrl`, `network`); these
 * are the ones that must be present and non-empty. The jsonb keeps the rest.
 */
const REQUIRED_DETAILS: Record<string, string[]> = {
  bank_transfer: ['bank', 'accountNumber', 'accountType', 'accountHolder', 'idDocument'],
  pago_movil: ['bank', 'phone', 'idDocument'],
  zelle: ['email', 'holder'],
  binance: ['identifier'],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_DOC_RE = /^[VEJ]-?\d{5,9}$/i;

/**
 * Per-field format checks keyed by `${type}.${key}`, applied on top of the
 * required-presence check. `email` = must be a valid address; `emailOrText` =
 * validate as email only when it looks like one (zelle/binance accept an email
 * OR a phone/pay-id); `idDocument` = canonical V/E/J document.
 */
const FIELD_FORMATS: Record<string, 'email' | 'emailOrText' | 'idDocument'> = {
  'zelle.email': 'emailOrText',
  'binance.identifier': 'emailOrText',
  'bank_transfer.idDocument': 'idDocument',
  'pago_movil.idDocument': 'idDocument',
};

function formatError(format: string, value: string): string | null {
  switch (format) {
    case 'email':
      return EMAIL_RE.test(value) ? null : 'debe ser un correo válido';
    case 'emailOrText':
      return value.includes('@') && !EMAIL_RE.test(value) ? 'el correo no es válido' : null;
    case 'idDocument':
      return ID_DOC_RE.test(value) ? null : 'el documento debe ser tipo V/E/J (ej. V-12345678)';
    default:
      return null;
  }
}

export interface CreatePaymentMethodInput {
  name: string;
  type: string;
  details: Record<string, unknown>;
}

export class PaymentMethodsService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly methods: PaymentMethodsRepository,
  ) {}

  list(): Promise<PaymentMethodRecord[]> {
    return this.methods.list();
  }

  async create(input: CreatePaymentMethodInput, actorId: string): Promise<PaymentMethodRecord> {
    const details = this.validateDetails(input.type, input.details);
    const record = await this.methods.create({
      name: input.name.trim(),
      type: input.type,
      details,
      createdBy: actorId,
    });
    await writeAudit(this.app.db, {
      actorAdminId: actorId,
      eventType: 'payment_method.created',
      entity: 'payment_methods',
      entityId: record.id,
      data: { name: record.name, type: record.type },
    });
    return record;
  }

  async update(
    id: number,
    data: { name?: string; type?: string; details?: Record<string, unknown>; isActive?: boolean },
    actorId: string,
  ): Promise<PaymentMethodRecord> {
    const patch: UpdatePaymentMethodData = {};
    if (data.name !== undefined) patch.name = data.name.trim();
    if (data.isActive !== undefined) patch.isActive = data.isActive;

    // Type and details are validated together: changing one needs the other so
    // the shape always matches the type.
    if (data.type !== undefined || data.details !== undefined) {
      if (data.type === undefined || data.details === undefined) {
        throw this.app.httpErrors.badRequest(
          'Para cambiar el tipo o los datos del método, envía ambos juntos',
        );
      }
      patch.type = data.type;
      patch.details = this.validateDetails(data.type, data.details);
    }

    const record = await this.methods.update(id, patch);
    if (!record) throw this.app.httpErrors.notFound('Método de pago no encontrado');
    await writeAudit(this.app.db, {
      actorAdminId: actorId,
      eventType: 'payment_method.updated',
      entity: 'payment_methods',
      entityId: id,
      data: { name: record.name, fields: Object.keys(data) },
    });
    return record;
  }

  async delete(id: number, actorId: string): Promise<void> {
    try {
      const deleted = await this.methods.delete(id);
      if (!deleted) throw this.app.httpErrors.notFound('Método de pago no encontrado');
      await writeAudit(this.app.db, {
        actorAdminId: actorId,
        eventType: 'payment_method.deleted',
        entity: 'payment_methods',
        entityId: id,
      });
    } catch (err) {
      if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
        throw this.app.httpErrors.conflict(
          'No se puede eliminar: el método de pago está en uso. Desactívalo en su lugar.',
        );
      }
      throw err;
    }
  }

  /** Ensures `details` carries the required fields for the type (non-empty strings). */
  private validateDetails(type: string, details: Record<string, unknown>): Record<string, unknown> {
    const required = REQUIRED_DETAILS[type];
    if (!required) throw this.app.httpErrors.badRequest('Tipo de método de pago no válido');

    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
      clean[key] = typeof value === 'string' ? value.trim() : value;
    }
    const missing = required.filter((k) => typeof clean[k] !== 'string' || (clean[k] as string) === '');
    if (missing.length > 0) {
      throw this.app.httpErrors.badRequest(
        `Faltan datos obligatorios del método de pago: ${missing.join(', ')}`,
      );
    }

    // Format checks on the present string fields (email, cédula).
    for (const [key, value] of Object.entries(clean)) {
      const format = FIELD_FORMATS[`${type}.${key}`];
      if (format && typeof value === 'string' && value) {
        const problem = formatError(format, value);
        if (problem) throw this.app.httpErrors.badRequest(`El campo "${key}" ${problem}`);
      }
    }
    return clean;
  }
}
