import type pg from 'pg';

export interface DashboardSummary {
  drivers: {
    approved: number;
    pending: number;
    suspended: number;
    /** Drivers on administrative leave (paused): frozen tariff, not operating. */
    paused: number;
    /** driver.approved events in the last 7 days vs the 7 before (audit log). */
    approvedLast7: number;
    approvedPrev7: number;
  };
  subscriptions: { dueSoon: number; expired: number; reminderDays: number };
  documents: { dueSoon: number; expired: number; warningDays: number };
  /** Money travels as decimal string, same convention as the rest of the API. */
  invoicing: { last7DaysUsd: string; last7DaysCount: number; prev7DaysUsd: string };
}

interface SummaryRow {
  approvedDrivers: string;
  pendingDrivers: string;
  suspendedDrivers: string;
  pausedDrivers: string;
  approvedLast7: string;
  approvedPrev7: string;
  dueSoon: string;
  expired: string;
  dueSoonDocs: string;
  expiredDocs: string;
  last7DaysUsd: string;
  last7DaysCount: string;
  prev7DaysUsd: string;
}

export interface RevenueSeriesPoint {
  /** Calendar day in the business timezone (YYYY-MM-DD). */
  date: string;
  /** Sum of non-voided invoices issued that day, as decimal string. */
  totalUsd: string;
  count: number;
}

export class DashboardRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Daily invoicing for the last N calendar days (business timezone), voided
   * excluded. Days without invoices come back as zero so the chart has a
   * continuous axis.
   */
  async revenueSeries(days: number, timezone: string): Promise<RevenueSeriesPoint[]> {
    const { rows } = await this.db.query<{ date: string; totalUsd: string; count: string }>(
      `WITH days AS (
         SELECT generate_series(
           (now() AT TIME ZONE $2)::date - ($1::int - 1),
           (now() AT TIME ZONE $2)::date,
           interval '1 day'
         )::date AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS "date",
              COALESCE(sum(i.total_usd), 0)::text AS "totalUsd",
              count(i.id)::text AS count
       FROM days d
       LEFT JOIN invoices i
         ON i.status <> 'voided'
        AND (i.issued_at AT TIME ZONE $2)::date = d.day
       GROUP BY d.day
       ORDER BY d.day`,
      [days, timezone],
    );
    return rows.map((r) => ({ date: r.date, totalUsd: r.totalUsd, count: Number(r.count) }));
  }

  async summary(reminderDays: number, docWarningDays: number, timezone: string): Promise<DashboardSummary> {
    const { rows } = await this.db.query<SummaryRow>(
      `SELECT
         -- status compared as text: a pooled connection with a stale catalog
         -- cache would otherwise reject a newly added enum value (see the note
         -- in plugins/subscription-scheduler.ts)
         (SELECT count(*) FROM drivers WHERE status::text = 'approved') AS "approvedDrivers",
         (SELECT count(*) FROM drivers WHERE status::text = 'pending') AS "pendingDrivers",
         (SELECT count(*) FROM drivers WHERE status::text = 'suspended') AS "suspendedDrivers",
         (SELECT count(*) FROM drivers WHERE status::text = 'paused') AS "pausedDrivers",
         -- Due soon = active subscriptions whose PAID coverage (advances included)
         -- runs out within the reminder window; prepaid renewals don't count.
         (SELECT count(*) FROM driver_subscriptions ds
          WHERE ds.status = 'active'
            AND COALESCE(
              (SELECT max(sp.period_end) FROM subscription_payments sp
               WHERE sp.driver_subscription_id = ds.id AND sp.status = 'paid'),
              ds.current_period_end
            ) <= now() + make_interval(days => $1)) AS "dueSoon",
         (SELECT count(*) FROM driver_subscriptions WHERE status = 'expired') AS "expired",
         (SELECT count(*) FROM documents doc
          WHERE doc.status = 'valid' AND doc.expires_at IS NOT NULL
            AND doc.expires_at <= (now() AT TIME ZONE $2)::date + ($3)::int) AS "dueSoonDocs",
         (SELECT count(*) FROM documents WHERE status = 'expired') AS "expiredDocs",
         (SELECT COALESCE(sum(total_usd), 0)::text FROM invoices
          WHERE status <> 'voided' AND issued_at >= now() - interval '7 days') AS "last7DaysUsd",
         (SELECT count(*) FROM invoices
          WHERE status <> 'voided' AND issued_at >= now() - interval '7 days') AS "last7DaysCount",
         -- Previous 7-day window, for the week-over-week trend
         (SELECT COALESCE(sum(total_usd), 0)::text FROM invoices
          WHERE status <> 'voided'
            AND issued_at >= now() - interval '14 days'
            AND issued_at < now() - interval '7 days') AS "prev7DaysUsd",
         -- Approvals come from the audit trail: drivers has no approved_at column
         (SELECT count(*) FROM audit_logs
          WHERE event_type = 'driver.approved'
            AND created_at >= now() - interval '7 days') AS "approvedLast7",
         (SELECT count(*) FROM audit_logs
          WHERE event_type = 'driver.approved'
            AND created_at >= now() - interval '14 days'
            AND created_at < now() - interval '7 days') AS "approvedPrev7"`,
      [reminderDays, timezone, docWarningDays],
    );
    const row = rows[0]!;
    return {
      drivers: {
        approved: Number(row.approvedDrivers),
        pending: Number(row.pendingDrivers),
        suspended: Number(row.suspendedDrivers),
        paused: Number(row.pausedDrivers),
        approvedLast7: Number(row.approvedLast7),
        approvedPrev7: Number(row.approvedPrev7),
      },
      subscriptions: {
        dueSoon: Number(row.dueSoon),
        expired: Number(row.expired),
        reminderDays,
      },
      documents: {
        dueSoon: Number(row.dueSoonDocs),
        expired: Number(row.expiredDocs),
        warningDays: docWarningDays,
      },
      invoicing: {
        last7DaysUsd: row.last7DaysUsd,
        last7DaysCount: Number(row.last7DaysCount),
        prev7DaysUsd: row.prev7DaysUsd,
      },
    };
  }
}
