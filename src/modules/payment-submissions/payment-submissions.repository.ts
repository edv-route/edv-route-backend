import type pg from 'pg';
import { withTransaction } from '../../db/tx.js';
import type { EnrollmentRepository } from '../drivers/enrollment.repository.js';

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
export type SubmissionPurpose = 'debt' | 'advance' | 'enroll';

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
}

export interface SubmissionListItem {
  id: string;
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
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** What the payment covers (breakdown), derived from the purpose + current debt. */
  items: { label: string; amountUsd: string }[];
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

  /** True when the driver already has a pending submission (the DB also enforces it). */
  async hasPending(driverId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM payment_submissions WHERE driver_id = $1 AND status = 'pending' LIMIT 1`,
      [driverId],
    );
    return rows.length > 0;
  }

  /** Inserts a pending submission with its files, in one transaction. */
  async create(input: CreateSubmissionInput): Promise<{ id: string }> {
    return withTransaction(this.db, async (client) => {
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
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const fromSql = `FROM payment_submissions ps JOIN users u ON u.id = ps.driver_id`;

    const countResult = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count ${fromSql} ${whereSql}`,
      values,
    );

    values.push(opts.limit, (opts.page - 1) * opts.limit);
    const { rows } = await this.db.query<SubmissionListItem>(
      `SELECT ps.id, ps.driver_id AS "driverId", u.full_name AS "driverName",
              ps.status, ps.amount_usd AS "amountUsd", pm.name AS "paymentMethodName",
              ps.paid_on AS "paidOn", ps.source, ps.created_at AS "createdAt",
              ps.reviewed_at AS "reviewedAt",
              (SELECT count(*) FROM payment_submission_files f WHERE f.submission_id = ps.id)::int AS "fileCount"
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
      `SELECT ps.id, ps.driver_id AS "driverId", u.full_name AS "driverName",
              ps.status, ps.purpose, ps.context, ps.amount_usd AS "amountUsd",
              pm.name AS "paymentMethodName",
              ps.paid_on AS "paidOn", ps.source, ps.created_at AS "createdAt",
              ps.reviewed_at AS "reviewedAt",
              ps.payment_reference AS "paymentReference", ps.payer_bank AS "payerBank",
              ps.payer_phone AS "payerPhone", ps.payer_id AS "payerId",
              ps.payer_account AS "payerAccount", ps.note, ps.rejection_reason AS "rejectionReason",
              ra.full_name AS "reviewedByName", ps.invoice_id AS "invoiceId",
              i.invoice_number::text AS "invoiceNumber", 0 AS "fileCount"
       FROM payment_submissions ps
       JOIN users u ON u.id = ps.driver_id
       LEFT JOIN payment_methods pm ON pm.id = ps.payment_method_id
       LEFT JOIN admins ra ON ra.id = ps.reviewed_by
       LEFT JOIN invoices i ON i.id = ps.invoice_id
       WHERE ps.id = $1`,
      [id],
    );
    const head = rows[0];
    if (!head) return null;

    const items = await this.buildItems(head.driverId, head.purpose, head.context);
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
    driverId: string,
    purpose: string,
    context: Record<string, unknown>,
  ): Promise<{ label: string; amountUsd: string }[]> {
    if (purpose === 'debt') {
      const { rows } = await this.db.query<{ label: string; amountUsd: string }>(
        `SELECT 'Membresía' AS label, amount_usd::text AS "amountUsd"
           FROM membership_payments WHERE driver_id = $1 AND status = 'pending'
         UNION ALL
         SELECT CASE WHEN sp.charge_kind::text = 'penalty' THEN 'Penalización'
                     ELSE 'Semana de tarifa' END AS label,
                sp.amount_usd::text AS "amountUsd"
           FROM subscription_payments sp
           JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
           WHERE ds.driver_id = $1
             AND (sp.status = 'overdue' OR (sp.status = 'pending' AND sp.invoice_id IS NOT NULL))`,
        [driverId],
      );
      return rows;
    }
    const items: { label: string; amountUsd: string }[] = [];
    const periods = Number(context['periods'] ?? 0);
    const planPrice = Number(context['planPriceUsd'] ?? 0);
    if (purpose === 'enroll') {
      items.push({ label: 'Membresía', amountUsd: Number(context['membershipPriceUsd'] ?? 0).toFixed(2) });
    }
    for (let i = 0; i < periods; i++) {
      items.push({ label: 'Semana de tarifa', amountUsd: planPrice.toFixed(2) });
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
        invoiceId = adv.invoiceId;
        invoiceNumber = adv.invoiceNumber;
        settledCharges = ctx.periods;
      } else if (sub.purpose === 'enroll') {
        const ctx = sub.context as unknown as EnrollContext;
        const enr = await this.enrollment.enrollOnClient(client, {
          driverId: sub.driverId,
          membershipId: ctx.membershipId,
          membershipPriceUsd: ctx.membershipPriceUsd,
          planId: ctx.planId,
          planPriceUsd: ctx.planPriceUsd,
          periods: ctx.periods,
          periodInterval: ctx.periodInterval,
          registeredBy: adminId,
          submissionId: id,
        });
        invoiceId = enr.invoiceId;
        invoiceNumber = enr.invoiceNumbers[0] ?? '';
        settledCharges = 1 + ctx.periods;
      } else {
        const settle = await this.enrollment.settleDebtOnClient(client, {
          driverId: sub.driverId,
          registeredBy: adminId,
          submissionId: id,
        });
        if (!settle) return { ok: false, reason: 'no_debt' };
        invoiceId = settle.invoiceId;
        invoiceNumber = settle.invoiceNumber;
        settledCharges = settle.settledCharges;
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
}
