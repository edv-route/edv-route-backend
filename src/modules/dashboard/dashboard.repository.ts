import type pg from 'pg';

export interface DashboardSummary {
  drivers: { approved: number; pending: number; suspended: number };
  subscriptions: { dueSoon: number; expired: number; reminderDays: number };
  /** Money travels as decimal string, same convention as the rest of the API. */
  invoicing: { last7DaysUsd: string; last7DaysCount: number };
}

interface SummaryRow {
  approvedDrivers: string;
  pendingDrivers: string;
  suspendedDrivers: string;
  dueSoon: string;
  expired: string;
  last7DaysUsd: string;
  last7DaysCount: string;
}

export class DashboardRepository {
  constructor(private readonly db: pg.Pool) {}

  async summary(reminderDays: number): Promise<DashboardSummary> {
    const { rows } = await this.db.query<SummaryRow>(
      `SELECT
         (SELECT count(*) FROM drivers WHERE status = 'approved') AS "approvedDrivers",
         (SELECT count(*) FROM drivers WHERE status = 'pending') AS "pendingDrivers",
         (SELECT count(*) FROM drivers WHERE status = 'suspended') AS "suspendedDrivers",
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
         (SELECT COALESCE(sum(total_usd), 0)::text FROM invoices
          WHERE status <> 'voided' AND issued_at >= now() - interval '7 days') AS "last7DaysUsd",
         (SELECT count(*) FROM invoices
          WHERE status <> 'voided' AND issued_at >= now() - interval '7 days') AS "last7DaysCount"`,
      [reminderDays],
    );
    const row = rows[0]!;
    return {
      drivers: {
        approved: Number(row.approvedDrivers),
        pending: Number(row.pendingDrivers),
        suspended: Number(row.suspendedDrivers),
      },
      subscriptions: {
        dueSoon: Number(row.dueSoon),
        expired: Number(row.expired),
        reminderDays,
      },
      invoicing: {
        last7DaysUsd: row.last7DaysUsd,
        last7DaysCount: Number(row.last7DaysCount),
      },
    };
  }
}
