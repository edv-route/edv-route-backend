import type pg from 'pg';
import type Invoices from '../../db/models/public/Invoices.js';
import type VDriverPayments from '../../db/models/public/VDriverPayments.js';
import type { Camelize } from '../../db/case-types.js';

type InvoiceRow = Camelize<Invoices>;
type PaymentRow = Camelize<VDriverPayments>;

export type InvoiceListItem = Pick<
  InvoiceRow,
  'id' | 'invoiceNumber' | 'totalUsd' | 'status' | 'issuedAt' | 'voidedAt'
> & {
  driverId: string;
  driverName: string;
  voidedByName: string | null;
  paymentMethodName: string | null;
  paymentReference: string | null;
  payerBank: string | null;
  hasProof: boolean;
};

/** Kanel cannot infer nullability in views: periods are NULL for memberships. */
export type PaymentListItem = Omit<PaymentRow, 'periodStart' | 'periodEnd' | 'refundedBy'> & {
  periodStart: Date | null;
  periodEnd: Date | null;
  driverName: string;
  invoiceNumber: string | null;
};

export interface InvoiceListFilters {
  status?: string;
  driverId?: string;
  search?: string;
  page: number;
  limit: number;
}

export interface PaymentListFilters {
  kind?: string;
  status?: string;
  driverId?: string;
  search?: string;
  page: number;
  limit: number;
}

export interface MonthlyInvoicingPoint {
  /** First day of the month in the business timezone (YYYY-MM-01). */
  month: string;
  /** Sum of non-voided invoices issued that month, decimal string. */
  totalUsd: string;
  count: number;
}

export class BillingRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Invoicing per calendar month for the last N months (business timezone),
   * voided excluded. Months with no invoices come back as zero so the bar
   * chart has a continuous axis.
   */
  async monthlySeries(months: number, timezone: string): Promise<MonthlyInvoicingPoint[]> {
    const { rows } = await this.db.query<{ month: string; totalUsd: string; count: string }>(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', (now() AT TIME ZONE $2)::date) - make_interval(months => $1::int - 1),
           date_trunc('month', (now() AT TIME ZONE $2)::date),
           interval '1 month'
         )::date AS month
       )
       SELECT to_char(m.month, 'YYYY-MM-DD') AS "month",
              COALESCE(sum(i.total_usd), 0)::text AS "totalUsd",
              count(i.id)::text AS count
       FROM months m
       LEFT JOIN invoices i
         ON i.status <> 'voided'
        AND date_trunc('month', (i.issued_at AT TIME ZONE $2)::date) = m.month
       GROUP BY m.month
       ORDER BY m.month`,
      [months, timezone],
    );
    return rows.map((r) => ({ month: r.month, totalUsd: r.totalUsd, count: Number(r.count) }));
  }

  async listInvoices(opts: InvoiceListFilters): Promise<{ items: InvoiceListItem[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (opts.status) {
      values.push(opts.status);
      where.push(`i.status = $${values.length}`);
    }
    if (opts.driverId) {
      values.push(opts.driverId);
      where.push(`i.driver_id = $${values.length}`);
    }
    if (opts.search) {
      values.push(`%${opts.search}%`);
      where.push(`(u.full_name ILIKE $${values.length} OR i.invoice_number::text ILIKE $${values.length})`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const fromSql = `FROM invoices i JOIN users u ON u.id = i.driver_id`;

    const countResult = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count ${fromSql} ${whereSql}`,
      values,
    );

    values.push(opts.limit, (opts.page - 1) * opts.limit);
    const { rows } = await this.db.query<InvoiceListItem>(
      `SELECT i.id, i.invoice_number AS "invoiceNumber", i.total_usd AS "totalUsd",
              i.status, i.issued_at AS "issuedAt", i.voided_at AS "voidedAt",
              i.driver_id AS "driverId", u.full_name AS "driverName",
              va.full_name AS "voidedByName",
              pm.name AS "paymentMethodName", i.payment_reference AS "paymentReference",
              i.payer_bank AS "payerBank", (i.proof_url IS NOT NULL) AS "hasProof"
       ${fromSql}
       LEFT JOIN admins va ON va.id = i.voided_by
       LEFT JOIN payment_methods pm ON pm.id = i.payment_method_id
       ${whereSql}
       ORDER BY i.invoice_number DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    return { items: rows, total: Number(countResult.rows[0]!.count) };
  }

  async listPayments(opts: PaymentListFilters): Promise<{ items: PaymentListItem[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (opts.kind) {
      values.push(opts.kind);
      where.push(`p.kind = $${values.length}`);
    }
    if (opts.status) {
      values.push(opts.status);
      where.push(`p.status = $${values.length}`);
    }
    if (opts.driverId) {
      values.push(opts.driverId);
      where.push(`p.driver_id = $${values.length}`);
    }
    if (opts.search) {
      values.push(`%${opts.search}%`);
      where.push(`u.full_name ILIKE $${values.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const fromSql = `FROM v_driver_payments p JOIN users u ON u.id = p.driver_id`;

    const countResult = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count ${fromSql} ${whereSql}`,
      values,
    );

    values.push(opts.limit, (opts.page - 1) * opts.limit);
    const { rows } = await this.db.query<PaymentListItem>(
      `SELECT p.id, p.driver_id AS "driverId", p.kind, p.concept,
              p.amount_usd AS "amountUsd", p.status, p.paid_at AS "paidAt",
              p.refunded_at AS "refundedAt",
              p.period_start AS "periodStart", p.period_end AS "periodEnd",
              p.invoice_id AS "invoiceId", p.created_at AS "createdAt",
              u.full_name AS "driverName", i.invoice_number AS "invoiceNumber"
       ${fromSql}
       LEFT JOIN invoices i ON i.id = p.invoice_id
       ${whereSql}
       ORDER BY p.created_at DESC, p.period_start DESC NULLS LAST
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    return { items: rows, total: Number(countResult.rows[0]!.count) };
  }

  /** Invoice owner + current proof path, for attaching/reading the receipt. */
  async findInvoiceForProof(
    id: string,
  ): Promise<{ id: string; driverId: string; proofUrl: string | null } | null> {
    const { rows } = await this.db.query<{ id: string; driverId: string; proofUrl: string | null }>(
      `SELECT id, driver_id AS "driverId", proof_url AS "proofUrl" FROM invoices WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async setProofUrl(id: string, path: string): Promise<void> {
    await this.db.query(`UPDATE invoices SET proof_url = $2 WHERE id = $1`, [id, path]);
  }
}
