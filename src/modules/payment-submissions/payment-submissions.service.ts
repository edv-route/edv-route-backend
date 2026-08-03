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
import type {
  PaymentSubmissionMeta,
  PaymentSubmissionsRepository,
  SubmissionDetail,
} from './payment-submissions.repository.js';

const UNIQUE_VIOLATION = '23505';
const MAX_FILES = 5;
const SIGNED_URL_TTL_SECONDS = 60;

const PERIOD_INTERVALS: Record<string, string> = {
  daily: '1 day',
  weekly: '7 days',
  monthly: '1 month',
  annual: '1 year',
};

export interface UploadedFile {
  buffer: Buffer;
  mimeType: string;
}

export interface CreateSubmissionRequest extends PaymentSubmissionMeta {
  note: string | null;
  /** Captured amount, required for Efectivo Divisa (cash_usd) on a debt payment. */
  amountUsd: string | null;
  /** `debt` \| `advance` \| `enroll` \| `change_plan`. */
  purpose: 'debt' | 'advance' | 'enroll' | 'change_plan';
  /** Weeks; required for `advance`, `enroll` and `change_plan`. */
  periods: number | null;
  /** New tariff id; required for `change_plan`. */
  planId: number | null;
  source: 'app' | 'admin';
  submittedBy: string | null;
}

/** A submission file with a short-lived signed URL instead of the raw path. */
export interface SubmissionFileView {
  id: string;
  position: number;
  url: string;
}

/**
 * Payment submissions (v9): create (pending) → approve (settle debt + invoice) /
 * reject (trace). Owns file custody (1..5 images in the private bucket, same
 * magic-number validation as documents) and the business rules; the repository
 * does the SQL and the debt settling.
 */
export class PaymentSubmissionsService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly submissions: PaymentSubmissionsRepository,
  ) {}

  async create(
    driverId: string,
    input: CreateSubmissionRequest,
    files: UploadedFile[],
    actorId: string,
  ): Promise<{ id: string }> {
    await this.assertDriver(driverId);
    if (await this.submissions.hasPending(driverId)) {
      throw this.app.httpErrors.conflict(
        'El afiliado ya tiene un pago en revisión. Espera a que se resuelva antes de registrar otro.',
      );
    }

    const isCash = await this.methodIsCash(input.paymentMethodId);

    // A submission always carries evidence: cash carries 1..5 bill photos, the
    // rest a single receipt.
    if (files.length === 0) {
      throw this.app.httpErrors.badRequest('Se requiere al menos una imagen del comprobante');
    }
    if (files.length > MAX_FILES) {
      throw this.app.httpErrors.badRequest(`Máximo ${MAX_FILES} imágenes por pago`);
    }
    if (!isCash && files.length > 1) {
      throw this.app.httpErrors.badRequest('Este método admite un solo comprobante');
    }

    // Amount + context depend on the purpose. `advance` is defined by the tariff
    // price × weeks; `debt` is the captured cash or the derived outstanding debt.
    let amountUsd: string;
    let context: Record<string, unknown> = {};
    if (input.purpose === 'change_plan') {
      if (!input.periods || input.periods < 1) {
        throw this.app.httpErrors.badRequest('Indica cuántas semanas incluye el cambio de tarifa');
      }
      if (!input.planId) throw this.app.httpErrors.badRequest('Indica la nueva tarifa');
      const prep = await this.prepareChangePlanContext(driverId, input.planId, input.periods);
      context = prep.context;
      amountUsd = prep.amountUsd;
    } else if (input.purpose === 'enroll') {
      if (!input.periods || input.periods < 1) {
        throw this.app.httpErrors.badRequest('Indica cuántas semanas incluye el alta');
      }
      const prep = await this.prepareEnrollContext(driverId, input.periods);
      context = prep.context;
      amountUsd = prep.amountUsd;
    } else if (input.purpose === 'advance') {
      if (!input.periods || input.periods < 1) {
        throw this.app.httpErrors.badRequest('Indica cuántas semanas adelantar');
      }
      const prep = await this.prepareAdvanceContext(driverId, input.periods);
      context = prep.context;
      amountUsd = prep.amountUsd;
    } else if (isCash) {
      const amount = Number(input.amountUsd);
      if (!input.amountUsd || !Number.isFinite(amount) || amount <= 0) {
        throw this.app.httpErrors.badRequest('Indica el monto recibido en efectivo');
      }
      amountUsd = amount.toFixed(2);
    } else {
      const debt = await this.submissions.driverDebtTotal(driverId);
      if (Number(debt) <= 0) {
        throw this.app.httpErrors.badRequest('El afiliado no tiene deuda por pagar');
      }
      amountUsd = debt;
    }

    // Validate + upload every image before touching the DB (orphans in storage
    // are harmless, same as the other file flows).
    const storage = this.requireStorage();
    const filePaths: string[] = [];
    for (const file of files) {
      if (file.buffer.length === 0) throw this.app.httpErrors.badRequest('Un archivo está vacío');
      if (file.buffer.length > MAX_FILE_BYTES) {
        throw this.app.httpErrors.badRequest('Un archivo supera el máximo de 10 MB');
      }
      const sniffed = sniffMimeType(file.buffer);
      if (!sniffed || !isAllowedMimeType(sniffed)) {
        throw this.app.httpErrors.badRequest('Formato no admitido: solo PDF, JPG o PNG');
      }
      const path = `submissions/${driverId}/${randomUUID()}.${extensionFor(sniffed)}`;
      await storage.upload(path, file.buffer, sniffed);
      filePaths.push(path);
    }

    try {
      const { id } = await this.submissions.create({
        driverId,
        amountUsd,
        purpose: input.purpose,
        context,
        paymentMethodId: input.paymentMethodId ?? null,
        reference: input.reference?.trim() || null,
        payerBank: input.payerBank?.trim() || null,
        paidOn: input.paidOn?.trim() || null,
        payerPhone: input.payerPhone?.trim() || null,
        payerId: input.payerId?.trim() || null,
        payerAccount: input.payerAccount?.trim() || null,
        note: input.note?.trim() || null,
        source: input.source,
        submittedBy: input.submittedBy,
        filePaths,
      });
      await writeAudit(this.app.db, {
        actorAdminId: input.source === 'admin' ? actorId : null,
        eventType: 'payment_submission.created',
        entity: 'payment_submissions',
        entityId: id,
        data: { driverId, amountUsd, files: filePaths.length, source: input.source },
      });
      return { id };
    } catch (err) {
      // The partial unique index closes the race the hasPending check leaves open.
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('El afiliado ya tiene un pago en revisión');
      }
      throw err;
    }
  }

  list(opts: { status?: string; driverId?: string; page: number; limit: number }) {
    return this.submissions.list(opts);
  }

  /** Detail with each image resolved to a short-lived signed URL. */
  async detail(id: string): Promise<Omit<SubmissionDetail, 'files'> & { files: SubmissionFileView[] }> {
    const detail = await this.submissions.findDetail(id);
    if (!detail) throw this.app.httpErrors.notFound('Pago no encontrado');
    const files: SubmissionFileView[] = [];
    if (detail.files.length > 0) {
      const storage = this.requireStorage();
      for (const f of detail.files) {
        files.push({
          id: f.id,
          position: f.position,
          url: await storage.getSignedUrl(f.storagePath, SIGNED_URL_TTL_SECONDS),
        });
      }
    }
    return { ...detail, files };
  }

  async approve(id: string, adminId: string): Promise<{ invoiceNumber: string; settledCharges: number }> {
    const result = await this.submissions.approve(id, adminId);
    if (!result.ok) {
      if (result.reason === 'not_pending') {
        throw this.app.httpErrors.conflict('Solo se puede aprobar un pago pendiente');
      }
      throw this.app.httpErrors.conflict('El afiliado no tiene deuda por saldar con este pago');
    }
    await writeAudit(this.app.db, {
      actorAdminId: adminId,
      eventType: 'payment_submission.approved',
      entity: 'payment_submissions',
      entityId: id,
      data: { invoiceNumber: result.invoiceNumber, settledCharges: result.settledCharges },
    });
    return { invoiceNumber: result.invoiceNumber, settledCharges: result.settledCharges };
  }

  async reject(id: string, reason: string, adminId: string): Promise<void> {
    const ok = await this.submissions.reject(id, reason.trim(), adminId);
    if (!ok) throw this.app.httpErrors.conflict('Solo se puede rechazar un pago pendiente');
    await writeAudit(this.app.db, {
      actorAdminId: adminId,
      eventType: 'payment_submission.rejected',
      entity: 'payment_submissions',
      entityId: id,
      data: { reason: reason.trim() },
    });
  }

  /**
   * Validates an alta/enroll payment and builds its context: the driver must NOT
   * already have a membership payment; uses the active membership + weekly tariff.
   * Approval runs enrollOnClient (membership + N weeks, one invoice).
   */
  private async prepareEnrollContext(
    driverId: string,
    periods: number,
  ): Promise<{ context: Record<string, unknown>; amountUsd: string }> {
    const { rows: mp } = await this.app.db.query(
      `SELECT 1 FROM membership_payments WHERE driver_id = $1 AND status <> 'refunded'`,
      [driverId],
    );
    if (mp.length > 0) {
      throw this.app.httpErrors.conflict('Este afiliado ya tiene un pago de membresía');
    }
    const { rows: mem } = await this.app.db.query<{ id: number; priceUsd: string }>(
      `SELECT id, price_usd AS "priceUsd" FROM memberships WHERE active`,
    );
    const membership = mem[0];
    if (!membership) throw this.app.httpErrors.conflict('No existe una membresía vigente');
    const { rows: pl } = await this.app.db.query<{
      id: number;
      priceUsd: string;
      billingPeriod: string;
    }>(
      `SELECT id, price_usd AS "priceUsd", billing_period AS "billingPeriod"
       FROM subscription_plans WHERE active AND billing_period = 'weekly' ORDER BY id LIMIT 1`,
    );
    const plan = pl[0];
    if (!plan) throw this.app.httpErrors.conflict('No existe una tarifa semanal vigente');

    const membershipPriceUsd = Number(membership.priceUsd);
    const planPriceUsd = Number(plan.priceUsd);
    const context = {
      membershipId: membership.id,
      membershipPriceUsd,
      planId: plan.id,
      planPriceUsd,
      periods,
      periodInterval: PERIOD_INTERVALS[plan.billingPeriod] ?? '7 days',
    };
    return { context, amountUsd: (membershipPriceUsd + planPriceUsd * periods).toFixed(2) };
  }

  /**
   * Validates an advance and builds the context approval will use (mirrors the
   * renewal rules in DriversService): the driver must be approved with an active
   * or expired tariff still in the catalog and no scheduled plan change.
   */
  private async prepareAdvanceContext(
    driverId: string,
    periods: number,
  ): Promise<{ context: Record<string, unknown>; amountUsd: string }> {
    const { rows: dr } = await this.app.db.query<{ status: string }>(
      `SELECT status::text AS status FROM drivers WHERE user_id = $1`,
      [driverId],
    );
    if (dr[0]?.status !== 'approved') {
      throw this.app.httpErrors.conflict('Solo se adelanta la tarifa de afiliados aprobados');
    }
    const { rows: subs } = await this.app.db.query<{
      id: string;
      status: string;
      billingPeriod: string;
      priceUsd: string;
      active: boolean;
    }>(
      `SELECT ds.id, ds.status::text AS status, sp.billing_period::text AS "billingPeriod",
              sp.price_usd AS "priceUsd", sp.active
       FROM driver_subscriptions ds
       JOIN subscription_plans sp ON sp.id = ds.plan_id
       WHERE ds.driver_id = $1 AND ds.status IN ('active', 'expired')
       ORDER BY ds.created_at DESC LIMIT 1`,
      [driverId],
    );
    const sub = subs[0];
    if (!sub) {
      throw this.app.httpErrors.conflict('El afiliado no tiene una tarifa activa ni vencida que renovar');
    }
    if (!sub.active) {
      throw this.app.httpErrors.conflict(
        'La tarifa del afiliado fue retirada del catálogo: elige una vigente para renovar',
      );
    }
    const { rows: sched } = await this.app.db.query(
      `SELECT 1 FROM driver_subscriptions WHERE driver_id = $1 AND status = 'scheduled'`,
      [driverId],
    );
    if (sched.length > 0) {
      throw this.app.httpErrors.conflict('Ya hay un cambio de tarifa programado. Cancélalo antes de adelantar.');
    }

    const timezone = String(await this.getSetting('business_timezone', 'America/Caracas'));
    const engineOn = (await this.getSetting('debt_engine_enabled', false)) === true;
    const planPriceUsd = Number(sub.priceUsd);
    const context = {
      subscriptionId: sub.id,
      planPriceUsd,
      periods,
      periodInterval: PERIOD_INTERVALS[sub.billingPeriod] ?? '7 days',
      timezone,
      reactivate: sub.status === 'expired',
      anchorWeekly: sub.billingPeriod === 'weekly' && engineOn,
    };
    return { context, amountUsd: (planPriceUsd * periods).toFixed(2) };
  }

  /**
   * Validates a plan change and builds its context (mirrors DriversService):
   * approved driver with an active/expired tariff, a different active new plan
   * and no scheduled change. `immediate` when the current tariff is expired.
   */
  private async prepareChangePlanContext(
    driverId: string,
    newPlanId: number,
    periods: number,
  ): Promise<{ context: Record<string, unknown>; amountUsd: string }> {
    const { rows: dr } = await this.app.db.query<{ status: string }>(
      `SELECT status::text AS status FROM drivers WHERE user_id = $1`,
      [driverId],
    );
    if (dr[0]?.status !== 'approved') {
      throw this.app.httpErrors.conflict('Solo se cambia la tarifa de afiliados aprobados');
    }
    const { rows: subs } = await this.app.db.query<{ id: string; status: string; planId: number }>(
      `SELECT ds.id, ds.status::text AS status, ds.plan_id AS "planId"
       FROM driver_subscriptions ds
       WHERE ds.driver_id = $1 AND ds.status IN ('active', 'expired')
       ORDER BY ds.created_at DESC LIMIT 1`,
      [driverId],
    );
    const sub = subs[0];
    if (!sub) throw this.app.httpErrors.conflict('El afiliado no tiene una tarifa activa ni vencida');
    if (sub.planId === newPlanId) {
      throw this.app.httpErrors.badRequest('La nueva tarifa es la misma que la actual');
    }
    const { rows: sched } = await this.app.db.query(
      `SELECT 1 FROM driver_subscriptions WHERE driver_id = $1 AND status = 'scheduled'`,
      [driverId],
    );
    if (sched.length > 0) {
      throw this.app.httpErrors.conflict('Ya hay un cambio de tarifa programado. Cancélalo primero.');
    }
    const { rows: pl } = await this.app.db.query<{
      id: number;
      priceUsd: string;
      billingPeriod: string;
      active: boolean;
    }>(
      `SELECT id, price_usd AS "priceUsd", billing_period AS "billingPeriod", active
       FROM subscription_plans WHERE id = $1`,
      [newPlanId],
    );
    const plan = pl[0];
    if (!plan || !plan.active) {
      throw this.app.httpErrors.badRequest('La tarifa elegida no existe o está archivada');
    }

    const timezone = String(await this.getSetting('business_timezone', 'America/Caracas'));
    const engineOn = (await this.getSetting('debt_engine_enabled', false)) === true;
    const planPriceUsd = Number(plan.priceUsd);
    const context = {
      currentSubscriptionId: sub.id,
      newPlanId: plan.id,
      planPriceUsd,
      periods,
      periodInterval: PERIOD_INTERVALS[plan.billingPeriod] ?? '7 days',
      timezone,
      mode: sub.status === 'expired' ? 'immediate' : 'scheduled',
      anchorWeekly: plan.billingPeriod === 'weekly' && engineOn,
    };
    return { context, amountUsd: (planPriceUsd * periods).toFixed(2) };
  }

  private async getSetting(key: string, fallback: unknown): Promise<unknown> {
    const { rows } = await this.app.db.query<{ value: unknown }>(
      'SELECT value FROM app_settings WHERE key = $1',
      [key],
    );
    return rows[0]?.value ?? fallback;
  }

  /** True when the method is Efectivo Divisa (cash_usd): captured with amount + bill photos. */
  private async methodIsCash(paymentMethodId: number | null | undefined): Promise<boolean> {
    if (!paymentMethodId) return false;
    const { rows } = await this.app.db.query<{ type: string }>(
      'SELECT type::text AS type FROM payment_methods WHERE id = $1',
      [paymentMethodId],
    );
    return rows[0]?.type === 'cash_usd';
  }

  private async assertDriver(driverId: string): Promise<void> {
    const { rows } = await this.app.db.query('SELECT 1 FROM drivers WHERE user_id = $1', [driverId]);
    if (rows.length === 0) throw this.app.httpErrors.notFound('Afiliado no encontrado');
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
