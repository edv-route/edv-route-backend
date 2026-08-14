import type pg from 'pg';
import { withTransaction } from '../../db/tx.js';
import type { EnrollmentRepository } from '../drivers/enrollment.repository.js';

/** Pool or in-transaction client: the multi-pending guard re-check must run on
 *  the same client that will insert, under the per-driver advisory lock. */
type Executor = {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[],
  ): Promise<pg.QueryResult<R>>;
};

/** Raised inside create()'s transaction when the multi-pending guard is violated
 *  under the per-driver lock — a race the service's pre-check could not see. */
export class PendingGuardError extends Error {
  constructor(readonly kind: 'whole_debt' | 'reserved' | 'has_pending') {
    super('pending-payment guard violated');
    this.name = 'PendingGuardError';
  }
}

/** Payer/method details captured with the submission (mirrors the invoice columns). */
export interface PaymentSubmissionMeta {
  paymentMethodId: number | null;
  reference: string | null;
  payerBank: string | null;
  paidOn: string | null;
  payerPhone: string | null;
  payerId: string | null;
  payerAccount: string | null;
}

/** What the payment is for + the parameters approval needs. */
export type SubmissionPurpose = 'debt' | 'advance' | 'enroll' | 'change_plan';

/** Context for an `advance` submission (renew/prepay N weeks of the current tariff). */
export interface AdvanceContext {
  subscriptionId: string;
  planPriceUsd: number;
  periods: number;
  periodInterval: string;
  timezone: string;
  reactivate: boolean;
  anchorWeekly: boolean;
}

/** Context for an `enroll` submission (alta / first payment: membership + N weeks). */
export interface EnrollContext {
  membershipId: number;
  membershipPriceUsd: number;
  planId: number;
  planPriceUsd: number;
  periods: number;
  periodInterval: string;
}

/** Context for a `change_plan` submission (switch tariff + prepay N weeks). */
export interface ChangePlanContext {
  currentSubscriptionId: string;
  newPlanId: number;
  planPriceUsd: number;
  periods: number;
  periodInterval: string;
  timezone: string;
  mode: 'scheduled' | 'immediate';
  anchorWeekly: boolean;
}

export interface CreateSubmissionInput extends PaymentSubmissionMeta {
  driverId: string;
  amountUsd: string;
  note: string | null;
  purpose: SubmissionPurpose;
  context: Record<string, unknown>;
  source: 'app' | 'admin';
  /** Admin id when registered from the panel; null when it comes from the app. */
  submittedBy: string | null;
  /** 1..5 storage paths of the already-uploaded receipt/bill images. */
  filePaths: string[];
  /** Multi-pending guard inputs, re-checked under a per-driver lock in create(). */
  guard: { targetedInvoiceIds: string[] | null };
}

export interface SubmissionListItem {
  id: string;
  /** Continuous receipt number (the "N° de pago"). */
  submissionNumber: string;
  purpose: string;
  driverId: string;
  driverName: string;
  status: string;
  amountUsd: string;
  paymentMethodName: string | null;
  paidOn: Date | null;
  source: string;
  createdAt: Date;
  reviewedAt: Date | null;
  fileCount: number;
  /**
   * N° of every invoice this receipt is linked to (via its charges), sorted asc.
   * Null while none exist yet (e.g. a still-pending debt/advance not approved).
   */
  invoiceNumbers: string[] | null;
}

export interface SubmissionFile {
  id: string;
  storagePath: string;
  position: number;
}

export interface SubmissionDetail extends SubmissionListItem {
  purpose: string;
  paymentReference: string | null;
  payerBank: string | null;
  payerPhone: string | null;
  payerId: string | null;
  payerAccount: string | null;
  note: string | null;
  rejectionReason: string | null;
  reviewedByName: string | null;
  /** Reversal trace: type (refund/correction) + reason + who/when, when reverted. */
  reversalType: string | null;
  reversalReason: string | null;
  revertedByName: string | null;
  revertedAt: Date | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  /**
   * What the receipt covers, ONE line per invoice (billing redesign): the real
   * invoices linked to the receipt (with their N° once they exist), or — while
   * still pending with no invoices yet — the breakdown derived from the purpose.
   */
  items: {
    label: string;
    amountUsd: string;
    invoiceNumber: string | null;
    periodStart: Date | null;
    periodEnd: Date | null;
  }[];
  files: SubmissionFile[];
}

export type ApproveResult =
  | { ok: true; invoiceNumber: string; settledCharges: number }
  | { ok: false; reason: 'not_pending' | 'no_debt' };

/**
 * Payment submissions (v9): the reviewable unit of money-in. A submission is
 * created `pending`; approval settles the driver's debt (delegated to the shared
 * EnrollmentRepository.settleDebtOnClient) and materializes the invoice, while
 * rejection leaves the debt untouched with a trace. SQL only; business rules in
 * the service.
 */
export class PaymentSubmissionsRepository {
  constructor(
    private readonly db: pg.Pool,
    private readonly enrollment: EnrollmentRepository,
  ) {}

  /** Sum of a driver's current debt (alta debt + arrears + penalty), USD string. */
  async driverDebtTotal(driverId: string): Promise<string> {
    const { rows } = await this.db.query<{ total: string }>(
      `SELECT (COALESCE((
         SELECT sum(sp.amount_usd) FROM subscription_payments sp
         JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
         WHERE ds.driver_id = $1
           AND (sp.status = 'overdue' OR (sp.status = 'pending' AND sp.invoice_id IS NOT NULL))
       ), 0) + COALESCE((
         SELECT sum(amount_usd) FROM membership_payments
         WHERE driver_id = $1 AND status = 'pending'
       ), 0))::text AS total`,
      [driverId],
    );
    return Number(rows[0]?.total ?? 0).toFixed(2);
  }

  /** Sum of the SELECTED still-owed invoices of a driver (partial payment), USD. */
  async selectedInvoicesTotal(driverId: string, invoiceIds: string[]): Promise<string> {
    const { rows } = await this.db.query<{ total: string }>(
      `SELECT COALESCE(sum(c.amount_usd), 0)::text AS total
       FROM (
         SELECT mp.invoice_id, mp.amount_usd, mp.status::text AS status
           FROM membership_payments mp WHERE mp.driver_id = $1
         UNION ALL
         SELECT sp.invoice_id, sp.amount_usd, sp.status::text
           FROM subscription_payments sp
           JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
           WHERE ds.driver_id = $1
       ) c
       WHERE c.invoice_id = ANY($2::uuid[])
         AND (c.status = 'overdue' OR (c.status = 'pending' AND c.invoice_id IS NOT NULL))`,
      [driverId, invoiceIds],
    );
    return Number(rows[0]?.total ?? 0).toFixed(2);
  }

  /** True when the driver already has a pending submission. */
  async hasPending(driverId: string, executor: Executor = this.db): Promise<boolean> {
    const { rows } = await executor.query(
      `SELECT 1 FROM payment_submissions WHERE driver_id = $1 AND status = 'pending' LIMIT 1`,
      [driverId],
    );
    return rows.length > 0;
  }

  /**
   * True when a PENDING `debt` submission covers the WHOLE debt (no specific
   * invoices in its context): such a payment implicitly reserves every debt
   * invoice, so no other payment may coexist with it (double-charge guard —
   * a whole-debt receipt does not enumerate invoices, so `reservedInvoiceIds`
   * cannot see it).
   */
  async hasWholeDebtPending(driverId: string, executor: Executor = this.db): Promise<boolean> {
    const { rows } = await executor.query(
      `SELECT 1 FROM payment_submissions
        WHERE driver_id = $1 AND status = 'pending' AND purpose = 'debt'
          AND (context->'invoiceIds' IS NULL OR jsonb_typeof(context->'invoiceIds') <> 'array')
        LIMIT 1`,
      [driverId],
    );
    return rows.length > 0;
  }

  /**
   * Invoice ids already reserved by the driver's PENDING submissions — the
   * double-charge guard for allowing MULTIPLE pending payments (2026-08-12). A
   * `debt` submission reserves the invoices in its `context.invoiceIds`; a
   * generator submission (enroll/advance/change_plan) reserves the charges it
   * created (linked by `submission_id`). A new payment may not cover any of these.
   */
  async reservedInvoiceIds(driverId: string, executor: Executor = this.db): Promise<string[]> {
    const { rows } = await executor.query<{ invoiceId: string }>(
      `SELECT DISTINCT inv AS "invoiceId" FROM (
         SELECT jsonb_array_elements_text(ps.context->'invoiceIds') AS inv
         FROM payment_submissions ps
         WHERE ps.driver_id = $1 AND ps.status = 'pending'
           AND jsonb_typeof(ps.context->'invoiceIds') = 'array'
         UNION
         SELECT mp.invoice_id::text FROM membership_payments mp
         JOIN payment_submissions ps ON ps.id = mp.submission_id
         WHERE ps.driver_id = $1 AND ps.status = 'pending' AND mp.invoice_id IS NOT NULL
         UNION
         SELECT sp.invoice_id::text FROM subscription_payments sp
         JOIN payment_submissions ps ON ps.id = sp.submission_id
         WHERE ps.driver_id = $1 AND ps.status = 'pending' AND sp.invoice_id IS NOT NULL
       ) x WHERE inv IS NOT NULL`,
      [driverId],
    );
    return rows.map((r) => r.invoiceId);
  }

  /** Inserts a pending submission with its files, in one transaction. */
  async create(input: CreateSubmissionInput): Promise<{ id: string }> {
    return withTransaction(this.db, async (client) => {
      // Serialize concurrent submissions for the same driver: the multi-pending
      // guard is re-checked here, under a per-driver lock, so a race cannot bypass
      // it (the one-pending unique index was dropped 2026-08-12). The service
      // pre-checks the same guard for a friendly early error; this is the backstop.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
        `payment_submission:${input.driverId}`,
      ]);
      const targeted = input.guard.targetedInvoiceIds;
      if (targeted) {
        if (await this.hasWholeDebtPending(input.driverId, client)) {
          throw new PendingGuardError('whole_debt');
        }
        const reserved = new Set(await this.reservedInvoiceIds(input.driverId, client));
        if (targeted.some((id) => reserved.has(id))) throw new PendingGuardError('reserved');
      } else if (await this.hasPending(input.driverId, client)) {
        throw new PendingGuardError('has_pending');
      }

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO payment_submissions
           (driver_id, amount_usd, payment_method_id, payment_reference, payer_bank,
            paid_on, payer_phone, payer_id, payer_account, note, source, submitted_by,
            purpose, context)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
         RETURNING id`,
        [
          input.driverId, input.amountUsd, input.paymentMethodId, input.reference,
          input.payerBank, input.paidOn, input.payerPhone, input.payerId,
          input.payerAccount, input.note, input.source, input.submittedBy,
          input.purpose, JSON.stringify(input.context),
        ],
      );
      const id = rows[0]!.id;
      // Billing redesign (2026-08-04): an ALTA receipt GENERATES its invoices/
      // charges (pending) right here, linked to it — so they carry their N° while
      // pending and a rejection leaves them owed. Approval settles them. Other
      // purposes create/settle their charges at approval time.
      if (input.purpose === 'enroll') {
        const ctx = input.context as unknown as EnrollContext;
        await this.enrollment.enrollOnClient(client, {
          driverId: input.driverId,
          membershipId: ctx.membershipId,
          membershipPriceUsd: ctx.membershipPriceUsd,
          planId: ctx.planId,
          planPriceUsd: ctx.planPriceUsd,
          periods: ctx.periods,
          periodInterval: ctx.periodInterval,
          registeredBy: input.submittedBy,
          submissionId: id,
        });
      }
      for (let i = 0; i < input.filePaths.length; i++) {
        await client.query(
          `INSERT INTO payment_submission_files (submission_id, storage_path, position)
           VALUES ($1, $2, $3)`,
          [id, input.filePaths[i], i + 1],
        );
      }
      return { id };
    });
  }

  async list(opts: {
    status?: string;
    driverId?: string;
    search?: string;
    page: number;
    limit: number;
  }): Promise<{ items: SubmissionListItem[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (opts.status) {
      values.push(opts.status);
      where.push(`ps.status = $${values.length}`);
    }
    if (opts.driverId) {
      values.push(opts.driverId);
      where.push(`ps.driver_id = $${values.length}`);
    }
    // Free-text search: payer name (ILIKE) and/or receipt number (digits of the
    // term matched against submission_number, so "#18" / "18" both work).
    const term = opts.search?.trim();
    if (term) {
      values.push(`%${term}%`);
      const conds = [`u.full_name ILIKE $${values.length}`];
      const digits = term.replace(/\D/g, '');
      if (digits) {
        values.push(`%${digits}%`);
        conds.push(`ps.submission_number::text ILIKE $${values.length}`);
      }
      where.push(`(${conds.join(' OR ')})`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const fromSql = `FROM payment_submissions ps JOIN users u ON u.id = ps.driver_id`;

    const countResult = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count ${fromSql} ${whereSql}`,
      values,
    );

    values.push(opts.limit, (opts.page - 1) * opts.limit);
    const { rows } = await this.db.query<SubmissionListItem>(
      `SELECT ps.id, ps.submission_number::text AS "submissionNumber", ps.purpose,
              ps.driver_id AS "driverId", u.full_name AS "driverName",
              ps.status, ps.amount_usd AS "amountUsd", pm.name AS "paymentMethodName",
              ps.paid_on AS "paidOn", ps.source, ps.created_at AS "createdAt",
              ps.reviewed_at AS "reviewedAt",
              (SELECT count(*) FROM payment_submission_files f WHERE f.submission_id = ps.id)::int AS "fileCount",
              (SELECT array_agg(inv.invoice_number::text ORDER BY inv.invoice_number)
                 FROM (
                   SELECT invoice_id FROM membership_payments
                     WHERE submission_id = ps.id AND invoice_id IS NOT NULL
                   UNION
                   SELECT invoice_id FROM subscription_payments
                     WHERE submission_id = ps.id AND invoice_id IS NOT NULL
                 ) ch
                 JOIN invoices inv ON inv.id = ch.invoice_id) AS "invoiceNumbers"
       ${fromSql}
       LEFT JOIN payment_methods pm ON pm.id = ps.payment_method_id
       ${whereSql}
       ORDER BY (ps.status = 'pending') DESC, ps.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { items: rows, total: Number(countResult.rows[0]!.count) };
  }

  async findDetail(id: string): Promise<SubmissionDetail | null> {
    const { rows } = await this.db.query<
      Omit<SubmissionDetail, 'files' | 'items'> & { context: Record<string, unknown> }
    >(
      `SELECT ps.id, ps.submission_number::text AS "submissionNumber",
              ps.driver_id AS "driverId", u.full_name AS "driverName",
              ps.status, ps.purpose, ps.context, ps.amount_usd AS "amountUsd",
              pm.name AS "paymentMethodName",
              ps.paid_on AS "paidOn", ps.source, ps.created_at AS "createdAt",
              ps.reviewed_at AS "reviewedAt",
              ps.payment_reference AS "paymentReference", ps.payer_bank AS "payerBank",
              ps.payer_phone AS "payerPhone", ps.payer_id AS "payerId",
              ps.payer_account AS "payerAccount", ps.note, ps.rejection_reason AS "rejectionReason",
              ra.full_name AS "reviewedByName",
              ps.reversal_type::text AS "reversalType", ps.reversal_reason AS "reversalReason",
              ps.reverted_at AS "revertedAt", rv.full_name AS "revertedByName",
              ps.invoice_id AS "invoiceId",
              i.invoice_number::text AS "invoiceNumber", 0 AS "fileCount"
       FROM payment_submissions ps
       JOIN users u ON u.id = ps.driver_id
       LEFT JOIN payment_methods pm ON pm.id = ps.payment_method_id
       LEFT JOIN admins ra ON ra.id = ps.reviewed_by
       LEFT JOIN admins rv ON rv.id = ps.reverted_by
       LEFT JOIN invoices i ON i.id = ps.invoice_id
       WHERE ps.id = $1`,
      [id],
    );
    const head = rows[0];
    if (!head) return null;

    const items = await this.buildItems(id, head.driverId, head.purpose, head.context);
    const { rows: files } = await this.db.query<SubmissionFile>(
      `SELECT id, storage_path AS "storagePath", position
       FROM payment_submission_files WHERE submission_id = $1 ORDER BY position`,
      [id],
    );
    const { context: _context, ...rest } = head;
    return { ...rest, items, fileCount: files.length, files };
  }

  /** Breakdown of what the payment covers (for the review screen). */
  private async buildItems(
    submissionId: string,
    driverId: string,
    purpose: string,
    context: Record<string, unknown>,
  ): Promise<SubmissionDetail['items']> {
    // Real invoices linked to this receipt (via their charges): one line each,
    // with its N° and period. Present once the charges carry the submission_id.
    const { rows: real } = await this.db.query<SubmissionDetail['items'][number]>(
      `SELECT i.invoice_number::text AS "invoiceNumber", c.amount_usd::text AS "amountUsd",
              c.label, c.period_start AS "periodStart", c.period_end AS "periodEnd"
       FROM (
         SELECT invoice_id, amount_usd, 'Membresía' AS label,
                NULL::timestamptz AS period_start, NULL::timestamptz AS period_end
           FROM membership_payments WHERE submission_id = $1 AND invoice_id IS NOT NULL
         UNION ALL
         SELECT invoice_id, amount_usd,
                CASE WHEN charge_kind::text = 'penalty' THEN 'Penalización'
                     ELSE 'Tarifa de la semana' END,
                period_start, period_end
           FROM subscription_payments WHERE submission_id = $1 AND invoice_id IS NOT NULL
       ) c
       JOIN invoices i ON i.id = c.invoice_id
       ORDER BY i.invoice_number`,
      [submissionId],
    );
    if (real.length > 0) return real;

    // Still pending with no linked charges. `debt` covers EXISTING debt invoices
    // (they already carry their N°). A PARTIAL payment (`context.invoiceIds`) covers
    // only the selected invoices — show exactly those, not the driver's whole debt,
    // so the review screen matches the amount charged. Null = the whole debt.
    if (purpose === 'debt') {
      const rawIds = (context as { invoiceIds?: unknown }).invoiceIds;
      const invoiceIds = Array.isArray(rawIds) ? (rawIds as string[]) : null;
      const { rows } = await this.db.query<SubmissionDetail['items'][number]>(
        `SELECT i.invoice_number::text AS "invoiceNumber", c.amount_usd::text AS "amountUsd",
                c.label, c.period_start AS "periodStart", c.period_end AS "periodEnd"
         FROM (
           SELECT invoice_id, amount_usd, 'Membresía' AS label,
                  NULL::timestamptz AS period_start, NULL::timestamptz AS period_end
             FROM membership_payments WHERE driver_id = $1 AND status = 'pending'
           UNION ALL
           SELECT sp.invoice_id, sp.amount_usd,
                  CASE WHEN sp.charge_kind::text = 'penalty' THEN 'Penalización'
                       ELSE 'Tarifa de la semana' END,
                  sp.period_start, sp.period_end
             FROM subscription_payments sp
             JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
             WHERE ds.driver_id = $1
               AND (sp.status = 'overdue' OR (sp.status = 'pending' AND sp.invoice_id IS NOT NULL))
         ) c
         LEFT JOIN invoices i ON i.id = c.invoice_id
         WHERE ($2::uuid[] IS NULL OR c.invoice_id = ANY($2::uuid[]))
         ORDER BY i.invoice_number`,
        [driverId, invoiceIds],
      );
      // Alta advance (Forma A): the extra weeks are created only at approval, so
      // while pending they are shown from the context to match the amount charged.
      const advanceWeeks = Number((context as { advanceWeeks?: unknown }).advanceWeeks ?? 0);
      const planPrice = Number((context as { planPriceUsd?: unknown }).planPriceUsd ?? 0);
      const items = [...rows];
      for (let i = 0; i < advanceWeeks; i++) {
        items.push({
          label: 'Tarifa de la semana',
          amountUsd: planPrice.toFixed(2),
          invoiceNumber: null,
          periodStart: null,
          periodEnd: null,
        });
      }
      return items;
    }
    const items: SubmissionDetail['items'] = [];
    const periods = Number(context['periods'] ?? 0);
    const planPrice = Number(context['planPriceUsd'] ?? 0);
    if (purpose === 'enroll') {
      items.push({
        label: 'Membresía',
        amountUsd: Number(context['membershipPriceUsd'] ?? 0).toFixed(2),
        invoiceNumber: null, periodStart: null, periodEnd: null,
      });
    }
    for (let i = 0; i < periods; i++) {
      items.push({
        label: 'Tarifa de la semana',
        amountUsd: planPrice.toFixed(2),
        invoiceNumber: null, periodStart: null, periodEnd: null,
      });
    }
    return items;
  }

  /**
   * Approves a submission in one transaction, dispatching by purpose: `debt`
   * settles the outstanding debt, `advance` prepays N tariff weeks (ONE invoice).
   * Then copies the submission's payment meta onto the resulting invoice, links
   * it and marks the submission approved. Meta + context are read from the
   * locked submission row. Returns a discriminated result so the service can map
   * "not pending" / "no debt" to the right HTTP error.
   */
  async approve(id: string, adminId: string): Promise<ApproveResult> {
    return withTransaction(this.db, async (client) => {
      const { rows } = await client.query<{
        driverId: string;
        status: string;
        purpose: SubmissionPurpose;
        context: Record<string, unknown>;
        paymentMethodId: number | null;
        reference: string | null;
        payerBank: string | null;
        paidOn: Date | null;
        payerPhone: string | null;
        payerId: string | null;
        payerAccount: string | null;
      }>(
        `SELECT driver_id AS "driverId", status, purpose, context,
                payment_method_id AS "paymentMethodId", payment_reference AS "reference",
                payer_bank AS "payerBank", paid_on AS "paidOn", payer_phone AS "payerPhone",
                payer_id AS "payerId", payer_account AS "payerAccount"
         FROM payment_submissions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const sub = rows[0];
      if (!sub || sub.status !== 'pending') return { ok: false, reason: 'not_pending' };

      let invoiceId: string | null;
      let invoiceNumber: string;
      let settledCharges: number;
      if (sub.purpose === 'advance') {
        const ctx = sub.context as unknown as AdvanceContext;
        const adv = await this.enrollment.settleAdvanceOnClient(client, {
          ...ctx,
          driverId: sub.driverId,
          registeredBy: adminId,
          submissionId: id,
        });
        // Advance now emits N invoices (one per week); details live on the receipt.
        invoiceId = null;
        invoiceNumber = adv.invoiceNumbers[0] ?? '';
        settledCharges = ctx.periods;
      } else if (sub.purpose === 'enroll') {
        // The invoices/charges were generated (pending) when the receipt was
        // created; approval just settles them (membership + N weeks → paid).
        const ctx = sub.context as unknown as EnrollContext;
        await this.enrollment.markReceiptChargesPaid(client, id);
        invoiceId = null;
        invoiceNumber = '';
        settledCharges = 1 + ctx.periods;
      } else if (sub.purpose === 'change_plan') {
        const ctx = sub.context as unknown as ChangePlanContext;
        const cp = await this.enrollment.settleChangePlanOnClient(client, {
          ...ctx,
          driverId: sub.driverId,
          registeredBy: adminId,
          submissionId: id,
        });
        // Plan change now emits N invoices (one per week); details on the receipt.
        invoiceId = null;
        invoiceNumber = cp.invoiceNumbers[0] ?? '';
        settledCharges = ctx.periods;
      } else {
        // Partial payment: the receipt settles only the selected invoices (each in
        // full). `invoiceIds` in the context restricts them; absent = all debt.
        const ctx = sub.context as {
          invoiceIds?: string[];
          advanceWeeks?: number;
          subscriptionId?: string;
          planPriceUsd?: number;
        };
        const settle = await this.enrollment.settleDebtOnClient(client, {
          driverId: sub.driverId,
          registeredBy: adminId,
          submissionId: id,
          invoiceIds: ctx.invoiceIds ?? null,
        });
        if (!settle) return { ok: false, reason: 'no_debt' };
        settledCharges = settle.settledCharges;
        // Alta advance (Forma A): pay N extra weeks on top of the base alta debt.
        // Created PAID here — not at submission time — so a rejected payment leaves
        // NO phantom debt. Anchored with the base week at startTariff.
        const advanceWeeks = Number(ctx.advanceWeeks ?? 0);
        if (advanceWeeks > 0 && ctx.subscriptionId) {
          await this.enrollment.addPaidAltaWeeksOnClient(client, {
            driverId: sub.driverId,
            subscriptionId: ctx.subscriptionId,
            planPriceUsd: Number(ctx.planPriceUsd ?? 0),
            periods: advanceWeeks,
            registeredBy: adminId,
            submissionId: id,
          });
          settledCharges += advanceWeeks;
        }
        // Debt now settles per-concept invoices; payment details live on the receipt.
        invoiceId = null;
        invoiceNumber = '';
      }

      if (invoiceId) {
        await client.query(
          `UPDATE invoices
              SET payment_method_id = $2, payment_reference = $3, payer_bank = $4,
                  paid_on = $5, payer_phone = $6, payer_id = $7, payer_account = $8
            WHERE id = $1 AND status = 'issued'`,
          [
            invoiceId, sub.paymentMethodId, sub.reference, sub.payerBank,
            sub.paidOn, sub.payerPhone, sub.payerId, sub.payerAccount,
          ],
        );
        // The invoice's receipt IS the submission's first image: reference the same
        // path in the private bucket (the binary is never duplicated, regla #3). A
        // cash payment with no photo simply leaves the invoice without proof.
        await client.query(
          `UPDATE invoices SET proof_url = (
             SELECT storage_path FROM payment_submission_files
             WHERE submission_id = $1 ORDER BY position LIMIT 1
           )
           WHERE id = $2 AND proof_url IS NULL
             AND EXISTS (SELECT 1 FROM payment_submission_files WHERE submission_id = $1)`,
          [id, invoiceId],
        );
      }
      await client.query(
        `UPDATE payment_submissions
            SET status = 'approved', reviewed_by = $2, reviewed_at = now(), invoice_id = $3
          WHERE id = $1`,
        [id, adminId, invoiceId],
      );
      return { ok: true, invoiceNumber, settledCharges };
    });
  }

  /** Rejects a pending submission (keeps the trace). False if it was not pending. */
  async reject(id: string, reason: string, adminId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE payment_submissions
          SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), rejection_reason = $3
        WHERE id = $1 AND status = 'pending'`,
      [id, adminId, reason],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Reverses an APPROVED receipt: undoes its money effects (enrollment.reverseReceipt)
   * and flips it to `reverted` with the trace, in one transaction. Returns false if
   * it was not approved. (Refund/correction merged 2026-08-06 — single action; the
   * legacy `reversal_type` column is left null.)
   */
  async reverse(id: string, adminId: string, reason: string): Promise<boolean> {
    return withTransaction(this.db, async (client) => {
      const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM payment_submissions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (rows[0]?.status !== 'approved') return false;
      await this.enrollment.reverseReceipt(client, { submissionId: id, adminId });
      await client.query(
        `UPDATE payment_submissions
            SET status = 'reverted', reverted_at = now(), reverted_by = $2, reversal_reason = $3
          WHERE id = $1`,
        [id, adminId, reason],
      );
      return true;
    });
  }
}
