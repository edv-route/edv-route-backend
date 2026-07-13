import type pg from 'pg';

export interface EnrollmentInput {
  driverId: string;
  membershipId: number;
  membershipPriceUsd: number;
  planId: number;
  planPriceUsd: number;
  periods: number; // 1 = basic, N = advance payment xN
  periodInterval: string; // e.g. '7 days' - derived from billing_period
  registeredBy: string;
}

export interface RejectionResult {
  refundedMembershipPayments: number;
  refundedSubscriptionPayments: number;
  voidedInvoices: number;
}

/**
 * Wizard step 4 + approval/rejection money flows (design doc v7):
 * invoice #1 groups membership + first tariff period; each extra advance
 * period gets its own invoice. All inside one transaction.
 */
export class EnrollmentRepository {
  constructor(private readonly db: pg.Pool) {}

  async enroll(input: EnrollmentInput): Promise<{ invoiceNumbers: string[] }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Invoice #1: membership + first tariff period
      const firstTotal = input.membershipPriceUsd + input.planPriceUsd;
      const inv1 = await this.createInvoice(client, input.driverId, firstTotal, input.registeredBy);

      await client.query(
        `INSERT INTO membership_payments
           (driver_id, membership_id, invoice_id, amount_usd, status, paid_at, registered_by)
         VALUES ($1, $2, $3, $4, 'paid', now(), $5)`,
        [input.driverId, input.membershipId, inv1.id, input.membershipPriceUsd, input.registeredBy],
      );

      const { rows: subRows } = await client.query<{ id: string }>(
        `INSERT INTO driver_subscriptions (driver_id, plan_id, status)
         VALUES ($1, $2, 'scheduled') RETURNING id`,
        [input.driverId, input.planId],
      );
      const subscriptionId = subRows[0]!.id;

      // Paid periods: N rows with exact consecutive windows (anchored at approval;
      // stored relative for now - approval shifts them to real dates)
      const invoiceNumbers = [inv1.invoiceNumber];
      for (let i = 0; i < input.periods; i++) {
        let invoiceId = inv1.id;
        if (i > 0) {
          const inv = await this.createInvoice(
            client, input.driverId, input.planPriceUsd, input.registeredBy,
          );
          invoiceId = inv.id;
          invoiceNumbers.push(inv.invoiceNumber);
        }
        await client.query(
          `INSERT INTO subscription_payments
             (driver_subscription_id, invoice_id, period_start, period_end,
              amount_usd, status, paid_at, registered_by)
           VALUES ($1, $2,
                   now() + ($3::interval * $4), now() + ($3::interval * ($4 + 1)),
                   $5, 'paid', now(), $6)`,
          [subscriptionId, invoiceId, input.periodInterval, i, input.planPriceUsd, input.registeredBy],
        );
      }

      await client.query(
        `UPDATE drivers SET registration_step = NULL WHERE user_id = $1`,
        [input.driverId],
      );

      await client.query('COMMIT');
      return { invoiceNumbers };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Approval: membership stands, tariff starts running from now. Periods end
   * at 00:00 (business timezone) of the corresponding day (decision 2026-07-10):
   * first period = now -> next midnight boundary of the interval; the rest are
   * exact consecutive intervals (already midnight-aligned).
   */
  async approve(driverId: string, periodInterval: string, timezone: string): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{ id: string }>(
        `SELECT ds.id FROM driver_subscriptions ds
         WHERE ds.driver_id = $1 AND ds.status = 'scheduled'
         FOR UPDATE`,
        [driverId],
      );
      const sub = rows[0];
      if (sub) {
        await client.query(
          `WITH anchor AS (
             SELECT date_trunc('day', (now() + $2::interval) AT TIME ZONE $3) AT TIME ZONE $3 AS first_end
           ), ordered AS (
             SELECT id, row_number() OVER (ORDER BY period_start) - 1 AS idx
             FROM subscription_payments
             WHERE driver_subscription_id = $1 AND status = 'paid'
           )
           UPDATE subscription_payments sp SET
             period_start = CASE WHEN o.idx = 0 THEN now()
                                 ELSE a.first_end + ($2::interval * (o.idx - 1)) END,
             period_end   = a.first_end + ($2::interval * o.idx)
           FROM ordered o, anchor a WHERE o.id = sp.id`,
          [sub.id, periodInterval, timezone],
        );
        await client.query(
          `UPDATE driver_subscriptions SET
             status = 'active', started_at = now(),
             current_period_start = now(),
             current_period_end = date_trunc('day', (now() + $2::interval) AT TIME ZONE $3) AT TIME ZONE $3
           WHERE id = $1`,
          [sub.id, periodInterval, timezone],
        );
      }

      await client.query(
        `UPDATE drivers SET status = 'approved' WHERE user_id = $1`,
        [driverId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Renewal: N new paid periods, one invoice each. If the subscription is
   * expired the payment reactivates it immediately (periods restart from now,
   * midnight-aligned); if still active, periods chain after the last paid one.
   */
  async renew(input: {
    subscriptionId: string;
    driverId: string;
    planPriceUsd: number;
    periods: number;
    periodInterval: string;
    timezone: string;
    reactivate: boolean;
    registeredBy: string;
  }): Promise<{ invoiceNumbers: string[] }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Anchor: expired -> restart from now; active -> chain after last paid period
      const { rows: anchorRows } = await client.query<{ base: Date }>(
        input.reactivate
          ? `SELECT date_trunc('day', (now() + $2::interval) AT TIME ZONE $3) AT TIME ZONE $3 AS base
             FROM driver_subscriptions WHERE id = $1 FOR UPDATE`
          : `SELECT COALESCE(
               (SELECT max(period_end) FROM subscription_payments
                WHERE driver_subscription_id = $1 AND status = 'paid'),
               date_trunc('day', (now() + $2::interval) AT TIME ZONE $3) AT TIME ZONE $3
             ) AS base
             FROM driver_subscriptions WHERE id = $1 FOR UPDATE`,
        [input.subscriptionId, input.periodInterval, input.timezone],
      );
      const base = anchorRows[0]!.base;

      const invoiceNumbers: string[] = [];
      for (let i = 0; i < input.periods; i++) {
        const invoice = await this.createInvoice(
          client, input.driverId, input.planPriceUsd, input.registeredBy,
        );
        invoiceNumbers.push(invoice.invoiceNumber);
        await client.query(
          `INSERT INTO subscription_payments
             (driver_subscription_id, invoice_id, period_start, period_end,
              amount_usd, status, paid_at, registered_by)
           VALUES ($1, $2,
                   CASE WHEN $7::boolean
                        THEN CASE WHEN $4 = 0 THEN now()
                                  ELSE $3::timestamptz + ($5::interval * ($4 - 1)) END
                        ELSE $3::timestamptz + ($5::interval * $4) END,
                   CASE WHEN $7::boolean
                        THEN $3::timestamptz + ($5::interval * $4)
                        ELSE $3::timestamptz + ($5::interval * ($4 + 1)) END,
                   $6, 'paid', now(), $8)`,
          [
            input.subscriptionId,
            invoice.id,
            base,
            i,
            input.periodInterval,
            input.planPriceUsd,
            input.reactivate,
            input.registeredBy,
          ],
        );
      }

      if (input.reactivate) {
        await client.query(
          `UPDATE driver_subscriptions SET
             status = 'active',
             current_period_start = now(),
             current_period_end = $2::timestamptz
           WHERE id = $1`,
          [input.subscriptionId, base],
        );
      }

      await client.query('COMMIT');
      return { invoiceNumbers };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Rejection: double refund + void every related invoice (numbers kept). */
  async reject(driverId: string, adminId: string): Promise<RejectionResult> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const mp = await client.query(
        `UPDATE membership_payments SET status = 'refunded', refunded_at = now(), refunded_by = $2
         WHERE driver_id = $1 AND status = 'paid'`,
        [driverId, adminId],
      );
      const sp = await client.query(
        `UPDATE subscription_payments sp SET status = 'refunded', refunded_at = now(), refunded_by = $2
         FROM driver_subscriptions ds
         WHERE sp.driver_subscription_id = ds.id AND ds.driver_id = $1 AND sp.status = 'paid'`,
        [driverId, adminId],
      );
      await client.query(
        `UPDATE driver_subscriptions SET status = 'cancelled', cancelled_at = now()
         WHERE driver_id = $1 AND status IN ('scheduled', 'pending_payment', 'active')`,
        [driverId],
      );
      const inv = await client.query(
        `UPDATE invoices SET status = 'voided', voided_at = now(), voided_by = $2
         WHERE driver_id = $1 AND status = 'issued'`,
        [driverId, adminId],
      );
      await client.query(
        `UPDATE drivers SET status = 'rejected' WHERE user_id = $1`,
        [driverId],
      );

      await client.query('COMMIT');
      return {
        refundedMembershipPayments: mp.rowCount ?? 0,
        refundedSubscriptionPayments: sp.rowCount ?? 0,
        voidedInvoices: inv.rowCount ?? 0,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async createInvoice(
    client: pg.PoolClient,
    driverId: string,
    totalUsd: number,
    registeredBy: string,
  ): Promise<{ id: string; invoiceNumber: string }> {
    const { rows } = await client.query<{ id: string; invoiceNumber: string }>(
      `INSERT INTO invoices (driver_id, total_usd, registered_by)
       VALUES ($1, $2, $3)
       RETURNING id, invoice_number::text AS "invoiceNumber"`,
      [driverId, totalUsd, registeredBy],
    );
    return rows[0]!;
  }
}
