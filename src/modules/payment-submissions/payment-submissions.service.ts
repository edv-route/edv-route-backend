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
import { PendingGuardError } from './payment-submissions.repository.js';
import type {
  PaymentSubmissionMeta,
  PaymentSubmissionsRepository,
  SubmissionDetail,
} from './payment-submissions.repository.js';

const UNIQUE_VIOLATION = '23505';
const MAX_FILES = 5;
const SIGNED_URL_TTL_SECONDS = 60;
// Alta advance (Forma A): weeks a driver may prepay are free per product; this is
// only a technical guard against a typo (e.g. 99999 weeks).
const MAX_ADVANCE_WEEKS = 520;

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
  /** `debt` \| `advance` \| `enroll` \| `change_plan`. */
  purpose: 'debt' | 'advance' | 'enroll' | 'change_plan';
  /** Weeks; required for `advance`, `enroll` and `change_plan`. */
  periods: number | null;
  /** New tariff id; required for `change_plan`. */
  planId: number | null;
  /** Debt payment: the specific invoices to settle (partial payment). Null = all. */
  invoiceIds: string[] | null;
  source: 'app' | 'admin';
  submittedBy: string | null;
  /** Admin-only toggle: approve the payment on the spot instead of leaving it
   *  pending for a second pass in Facturación. Ignored for the app channel. */
  autoApprove: boolean;
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
  ): Promise<{ id: string; approved: boolean }> {
    await this.assertDriver(driverId);
    // Multiple pending payments are allowed as long as they cover DIFFERENT
    // invoices (2026-08-12). A `debt` payment listing specific invoices may not
    // touch one already reserved by another pending submission (double-charge
    // guard); any other payment (whole-debt, enroll, advance, change_plan) still
    // requires no other pending payment.
    const targetedInvoiceIds =
      input.purpose === 'debt' && input.invoiceIds && input.invoiceIds.length > 0
        ? input.invoiceIds
        : null;
    if (targetedInvoiceIds) {
      // A whole-debt pending payment covers ALL debt (these invoices included),
      // so a targeted one may not coexist with it (double-charge guard).
      if (await this.submissions.hasWholeDebtPending(driverId)) {
        throw this.app.httpErrors.conflict(
          'Ya hay un pago en revisión que cubre toda la deuda del afiliado. Apruébalo o recházalo antes de registrar otro.',
        );
      }
      const reserved = new Set(await this.submissions.reservedInvoiceIds(driverId));
      if (targetedInvoiceIds.some((id) => reserved.has(id))) {
        throw this.app.httpErrors.conflict(
          'Alguna de esas facturas ya tiene un pago en revisión. Elige facturas distintas.',
        );
      }
    } else if (await this.submissions.hasPending(driverId)) {
      throw this.app.httpErrors.conflict(
        'El afiliado ya tiene un pago en revisión. Para registrar otro, indica las facturas específicas que cubre.',
      );
    }

    const isCash = await this.methodIsCash(input.paymentMethodId);

    // Evidence rules (2026-08-06): the receipt is now OPTIONAL for every method
    // (admin decision — verification moves to the approval step). Efectivo Divisa
    // still allows up to 5 bill photos; the other methods at most one when present.
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
      const prep = await this.prepareEnrollContext(driverId, input.periods, input.planId);
      context = prep.context;
      amountUsd = prep.amountUsd;
    } else if (input.purpose === 'advance') {
      if (!input.periods || input.periods < 1) {
        throw this.app.httpErrors.badRequest('Indica cuántas semanas adelantar');
      }
      const prep = await this.prepareAdvanceContext(driverId, input.periods);
      context = prep.context;
      amountUsd = prep.amountUsd;
    } else if (input.invoiceIds && input.invoiceIds.length > 0) {
      // Partial payment: settle only the SELECTED debt invoices (each in full).
      const total = await this.submissions.selectedInvoicesTotal(driverId, input.invoiceIds);
      if (Number(total) <= 0) {
        throw this.app.httpErrors.badRequest('Las facturas seleccionadas no tienen deuda por pagar');
      }
      amountUsd = total;
      // Which invoices this payment covers is recorded as ROWS in
      // payment_submission_invoices (repository.create), where a constraint can
      // police it. The context carries no copy of them on purpose.
      context = {};
    } else {
      // Whole outstanding debt. Each concept has its own invoice now, so the amount
      // is the debt itself — a captured cash amount no longer defines it.
      const debt = await this.submissions.driverDebtTotal(driverId);
      if (Number(debt) <= 0) {
        throw this.app.httpErrors.badRequest('El afiliado no tiene deuda por pagar');
      }
      // Alta advance (Forma A): the applicant may pay N weeks at the alta (the base
      // week plus N-1 extra). The base debt (membership + week 1) is settled as
      // usual; the extra weeks are created at approval, so a rejection leaves no
      // phantom debt.
      const advanceWeeks = input.periods && input.periods > 1 ? input.periods - 1 : 0;
      if (advanceWeeks > 0) {
        const prep = await this.prepareAltaAdvanceContext(driverId, advanceWeeks, debt);
        context = prep.context;
        amountUsd = prep.amountUsd;
      } else {
        amountUsd = debt;
      }
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
        guard: { targetedInvoiceIds },
      });
      await writeAudit(this.app.db, {
        actorAdminId: input.source === 'admin' ? actorId : null,
        actorUserId: input.source === 'app' ? actorId : null,
        eventType: 'payment_submission.created',
        entity: 'payment_submissions',
        entityId: id,
        data: { driverId, amountUsd, files: filePaths.length, source: input.source },
      });
      // Admin-only "approve immediately" toggle: create + approve in the same
      // request so the payment skips the second pass in Facturación. The app
      // channel never auto-approves (a driver cannot approve his own payment).
      if (input.autoApprove && input.source === 'admin') {
        await this.approve(id, actorId);
        return { id, approved: true };
      }
      return { id, approved: false };
    } catch (err) {
      // Lost the race for the per-driver lock: another pending payment landed
      // first and now reserves these invoices (backstop for the pre-check above).
      if (err instanceof PendingGuardError) {
        throw this.app.httpErrors.conflict(
          'El afiliado ya tiene un pago en revisión que cubre esas facturas. Actualiza y revisa los pagos pendientes.',
        );
      }
      // The one-pending unique index was dropped (2026-08-12); a unique violation
      // here is no longer the pending guard, so surface it generically.
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw this.app.httpErrors.conflict('No se pudo registrar el pago por un conflicto de datos.');
      }
      throw err;
    }
  }

  list(opts: { status?: string; driverId?: string; search?: string; page: number; limit: number }) {
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
   * Reverses an approved receipt (single action, refund/correction merged
   * 2026-08-06 — they did the same thing). The effect depends on how the money
   * moved: invoices the receipt GENERATED are voided; pre-existing debt it SETTLED
   * goes back to owed (so it can be re-charged). Keeps the trace; only an approved
   * receipt can be reverted.
   */
  async reverse(id: string, reason: string, adminId: string): Promise<void> {
    const ok = await this.submissions.reverse(id, adminId, reason.trim());
    if (!ok) throw this.app.httpErrors.conflict('Solo se puede revertir un pago aprobado');
    await writeAudit(this.app.db, {
      actorAdminId: adminId,
      eventType: 'payment_submission.reverted',
      entity: 'payment_submissions',
      entityId: id,
      data: { reason: reason.trim() },
    });
  }

  /**
   * Validates an alta ADVANCE (Forma A): the applicant pays [advanceWeeks] extra
   * weeks ON TOP of his base alta debt (membership + week 1). Requires the base
   * debt to exist as a `scheduled` weekly subscription (an approved solicitud not
   * yet paid/started). The amount is baseDebt + planPrice × advanceWeeks; the extra
   * weeks are created (paid) at approval. Weeks are free per product — only a
   * generous technical cap guards against a typo.
   */
  private async prepareAltaAdvanceContext(
    driverId: string,
    advanceWeeks: number,
    baseDebt: string,
  ): Promise<{ context: Record<string, unknown>; amountUsd: string }> {
    if (advanceWeeks > MAX_ADVANCE_WEEKS) {
      throw this.app.httpErrors.badRequest(
        `No puedes adelantar más de ${MAX_ADVANCE_WEEKS} semanas`,
      );
    }
    const { rows } = await this.app.db.query<{ id: string; priceUsd: string }>(
      `SELECT ds.id, sp.price_usd AS "priceUsd"
       FROM driver_subscriptions ds
       JOIN subscription_plans sp ON sp.id = ds.plan_id
       WHERE ds.driver_id = $1 AND ds.status = 'scheduled' AND sp.billing_period = 'weekly'
       ORDER BY ds.created_at DESC LIMIT 1`,
      [driverId],
    );
    const sub = rows[0];
    if (!sub) {
      throw this.app.httpErrors.conflict(
        'No se pueden adelantar semanas: el alta del afiliado aún no está lista.',
      );
    }
    const planPriceUsd = Number(sub.priceUsd);
    const amountUsd = (Number(baseDebt) + planPriceUsd * advanceWeeks).toFixed(2);
    return {
      context: { subscriptionId: sub.id, planPriceUsd, advanceWeeks },
      amountUsd,
    };
  }

  /**
   * Validates an alta/enroll payment and builds its context: the driver must NOT
   * already have a membership payment; uses the active membership + weekly tariff.
   * Approval runs enrollOnClient (membership + N weeks, one invoice).
   */
  private async prepareEnrollContext(
    driverId: string,
    periods: number,
    planId: number | null,
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
    // Honour the tariff chosen in the wizard (so the invoice matches the summary);
    // fall back to the sole active weekly one for callers that send no plan. It
    // must be weekly — enroll bills membership + N WEEKLY weeks.
    const { rows: pl } =
      planId != null
        ? await this.app.db.query<{ id: number; priceUsd: string; billingPeriod: string }>(
            `SELECT id, price_usd AS "priceUsd", billing_period AS "billingPeriod"
             FROM subscription_plans WHERE id = $1 AND active AND billing_period = 'weekly'`,
            [planId],
          )
        : await this.app.db.query<{ id: number; priceUsd: string; billingPeriod: string }>(
            `SELECT id, price_usd AS "priceUsd", billing_period AS "billingPeriod"
             FROM subscription_plans WHERE active AND billing_period = 'weekly' ORDER BY id LIMIT 1`,
          );
    const plan = pl[0];
    if (!plan) {
      throw this.app.httpErrors.conflict(
        planId != null
          ? 'La tarifa elegida no existe, está archivada o no es semanal'
          : 'No existe una tarifa semanal vigente',
      );
    }

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
