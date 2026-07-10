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

  /** Approval: membership stands, tariff starts running from now. */
  async approve(driverId: string, periodInterval: string): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{ id: string; paid: string }>(
        `SELECT ds.id,
                (SELECT count(*) FROM subscription_payments sp
                 WHERE sp.driver_subscription_id = ds.id AND sp.status = 'paid') AS paid
         FROM driver_subscriptions ds
         WHERE ds.driver_id = $1 AND ds.status = 'scheduled'
         FOR UPDATE`,
        [driverId],
      );
      const sub = rows[0];
      if (sub) {
        // Re-anchor paid periods to start now, consecutively
        await client.query(
          `WITH ordered AS (
             SELECT id, row_number() OVER (ORDER BY period_start) - 1 AS idx
             FROM subscription_payments
             WHERE driver_subscription_id = $1 AND status = 'paid'
           )
           UPDATE subscription_payments sp SET
             period_start = now() + ($2::interval * o.idx),
             period_end   = now() + ($2::interval * (o.idx + 1))
           FROM ordered o WHERE o.id = sp.id`,
          [sub.id, periodInterval],
        );
        await client.query(
          `UPDATE driver_subscriptions SET
             status = 'active', started_at = now(),
             current_period_start = now(),
             current_period_end = now() + $2::interval
           WHERE id = $1`,
          [sub.id, periodInterval],
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
