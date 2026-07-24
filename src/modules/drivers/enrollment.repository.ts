import type pg from 'pg';
import { withTransaction } from '../../db/tx.js';

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
    return withTransaction(this.db, (client) => this.enrollOnClient(client, input));
  }

  /**
   * Enrollment body on a caller-provided client (no transaction control): the
   * transactional registration runs it alongside the user/driver insert inside
   * a single unit of work, and `enroll` wraps it in its own transaction.
   */
  async enrollOnClient(
    client: pg.PoolClient,
    input: EnrollmentInput,
  ): Promise<{ invoiceNumbers: string[] }> {
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

    return { invoiceNumbers };
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

      // Approval leaves the driver `approved` and available (active by default:
      // the availability plane, decision 2026-07-23).
      await client.query(
        `UPDATE drivers SET status = 'approved', is_available = true WHERE user_id = $1`,
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
   * Resume from an administrative pause (Fase A, moving-window model): the
   * tariff clock was frozen while paused, so shift every not-yet-consumed period
   * window forward by the pause duration (now() - paused_at) to preserve the
   * remaining coverage, flip the driver back to `approved` + available and clear
   * `paused_at`. now() is the transaction timestamp, stable across statements.
   * The exact "re-anchor to Monday 00:00" behaviour belongs to the v8 weekly
   * model (Fase B); here the remaining coverage simply keeps running.
   */
  async resume(driverId: string): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{ pausedAt: Date | null }>(
        `SELECT paused_at AS "pausedAt" FROM drivers WHERE user_id = $1 FOR UPDATE`,
        [driverId],
      );
      const pausedAt = rows[0]?.pausedAt;
      if (pausedAt) {
        // Shift the live subscription window(s) by the pause duration.
        await client.query(
          `UPDATE driver_subscriptions SET
             current_period_start = current_period_start + (now() - $2::timestamptz),
             current_period_end = current_period_end + (now() - $2::timestamptz)
           WHERE driver_id = $1 AND status IN ('active', 'scheduled')`,
          [driverId, pausedAt],
        );
        // Shift every paid period that had not yet ended when the pause began
        // (the current one plus any advance ×N), keeping them consecutive.
        await client.query(
          `UPDATE subscription_payments sp SET
             period_start = sp.period_start + (now() - $2::timestamptz),
             period_end = sp.period_end + (now() - $2::timestamptz)
           FROM driver_subscriptions ds
           WHERE sp.driver_subscription_id = ds.id AND ds.driver_id = $1
             AND sp.status = 'paid' AND sp.period_end > $2::timestamptz`,
          [driverId, pausedAt],
        );
      }

      await client.query(
        `UPDATE drivers SET status = 'approved', is_available = true, paused_at = NULL
         WHERE user_id = $1`,
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

  /**
   * Plan change (design v5, implemented 2026-07-15). Two modes:
   *  - 'scheduled': the driver still has paid coverage, so the new plan is
   *    born `scheduled` and its periods start when that coverage runs out
   *    (advances are honoured, never refunded). The scheduler activates it.
   *  - 'immediate': no coverage left (expired/archived plan), the new plan
   *    starts running now and reactivates the driver's operation.
   * A new subscription row is created: the old one keeps its own history.
   */
  async changePlan(input: {
    driverId: string;
    currentSubscriptionId: string;
    newPlanId: number;
    planPriceUsd: number;
    periods: number;
    periodInterval: string;
    timezone: string;
    mode: 'scheduled' | 'immediate';
    registeredBy: string;
  }): Promise<{ invoiceNumbers: string[]; startsAt: Date }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const immediate = input.mode === 'immediate';
      const { rows: anchorRows } = await client.query<{ base: Date }>(
        immediate
          ? `SELECT date_trunc('day', (now() + $2::interval) AT TIME ZONE $3) AT TIME ZONE $3 AS base
             FROM driver_subscriptions WHERE id = $1 FOR UPDATE`
          : `SELECT COALESCE(
               (SELECT max(period_end) FROM subscription_payments
                WHERE driver_subscription_id = $1 AND status = 'paid'),
               date_trunc('day', (now() + $2::interval) AT TIME ZONE $3) AT TIME ZONE $3
             ) AS base
             FROM driver_subscriptions WHERE id = $1 FOR UPDATE`,
        [input.currentSubscriptionId, input.periodInterval, input.timezone],
      );
      const base = anchorRows[0]!.base;

      // $3 is cast explicitly: it feeds an enum column and a text comparison.
      const { rows: subRows } = await client.query<{ id: string }>(
        `INSERT INTO driver_subscriptions
           (driver_id, plan_id, status, started_at, current_period_start, current_period_end)
         VALUES ($1, $2, $3::subscription_status,
                 CASE WHEN $3::text = 'active' THEN now() END,
                 CASE WHEN $3::text = 'active' THEN now() END,
                 CASE WHEN $3::text = 'active' THEN $4::timestamptz END)
         RETURNING id`,
        [input.driverId, input.newPlanId, immediate ? 'active' : 'scheduled', base],
      );
      const newSubscriptionId = subRows[0]!.id;

      const invoiceNumbers: string[] = [];
      for (let i = 0; i < input.periods; i++) {
        const invoice = await this.createInvoice(
          client, input.driverId, input.planPriceUsd, input.registeredBy,
        );
        invoiceNumbers.push(invoice.invoiceNumber);
        // Immediate mode: the first period runs from now to the aligned base.
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
            newSubscriptionId,
            invoice.id,
            base,
            i,
            input.periodInterval,
            input.planPriceUsd,
            immediate,
            input.registeredBy,
          ],
        );
      }

      // Expired/archived plan: close the old subscription, the new one rules.
      if (immediate) {
        await client.query(
          `UPDATE driver_subscriptions SET status = 'cancelled', cancelled_at = now()
           WHERE id = $1 AND status <> 'cancelled'`,
          [input.currentSubscriptionId],
        );
      }

      await client.query('COMMIT');
      return { invoiceNumbers, startsAt: base };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Cancels a programmed plan change that has not started yet: its periods
   * are refunded and their invoices voided (money is never deleted, only
   * reversed with a trace). The running subscription is untouched.
   */
  async cancelScheduledChange(
    driverId: string,
    adminId: string,
  ): Promise<{ refundedPayments: number; voidedInvoices: number } | null> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM driver_subscriptions
         WHERE driver_id = $1 AND status = 'scheduled' FOR UPDATE`,
        [driverId],
      );
      const scheduled = rows[0];
      if (!scheduled) {
        await client.query('ROLLBACK');
        return null;
      }

      const invoices = await client.query(
        `UPDATE invoices SET status = 'voided', voided_at = now(), voided_by = $2
         WHERE status = 'issued' AND id IN (
           SELECT invoice_id FROM subscription_payments
           WHERE driver_subscription_id = $1 AND invoice_id IS NOT NULL
         )`,
        [scheduled.id, adminId],
      );
      const payments = await client.query(
        `UPDATE subscription_payments
         SET status = 'refunded', refunded_at = now(), refunded_by = $2
         WHERE driver_subscription_id = $1 AND status = 'paid'`,
        [scheduled.id, adminId],
      );
      await client.query(
        `UPDATE driver_subscriptions SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
        [scheduled.id],
      );

      await client.query('COMMIT');
      return {
        refundedPayments: payments.rowCount ?? 0,
        voidedInvoices: invoices.rowCount ?? 0,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * External payment (design v8, Fase B): the driver settled with the admin
   * outside the system (cash/transfer). Marks every outstanding charge - the
   * arrears AND the penalty fine - as paid in one transaction and issues ONE
   * invoice grouping them, so the money is recorded with a trace (regla de oro
   * #7) instead of the state being forced by hand. The debt engine then derives
   * the driver out of `overdue`/`penalized` on its own.
   * Returns null when there is nothing outstanding.
   */
  async registerExternalPayment(input: {
    driverId: string;
    registeredBy: string;
  }): Promise<{ invoiceNumber: string; settledCharges: number; totalUsd: string } | null> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const { rows: charges } = await client.query<{ id: string; amountUsd: string }>(
        `SELECT sp.id, sp.amount_usd AS "amountUsd"
         FROM subscription_payments sp
         JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
         WHERE ds.driver_id = $1 AND sp.status IN ('pending', 'overdue')
         FOR UPDATE OF sp`,
        [input.driverId],
      );
      if (charges.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const total = charges.reduce((sum, c) => sum + Number(c.amountUsd), 0);
      const invoice = await this.createInvoice(client, input.driverId, total, input.registeredBy);

      await client.query(
        `UPDATE subscription_payments
            SET status = 'paid', paid_at = now(), invoice_id = $2, registered_by = $3
          WHERE id = ANY($1::uuid[])`,
        [charges.map((c) => c.id), invoice.id, input.registeredBy],
      );

      await client.query('COMMIT');
      return {
        invoiceNumber: invoice.invoiceNumber,
        settledCharges: charges.length,
        totalUsd: total.toFixed(2),
      };
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

  /**
   * Stamps the payment details (method + reference + payer bank) on an issued
   * invoice, found by its number, and returns its id (used to attach the
   * receipt afterwards). Returns null if the invoice is not found / not issued.
   */
  async setInvoicePaymentMeta(
    invoiceNumber: string,
    meta: { paymentMethodId: number | null; reference: string | null; payerBank: string | null },
  ): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE invoices
          SET payment_method_id = $2, payment_reference = $3, payer_bank = $4
        WHERE invoice_number = $1::bigint AND status = 'issued'
        RETURNING id`,
      [invoiceNumber, meta.paymentMethodId, meta.reference, meta.payerBank],
    );
    return rows[0]?.id ?? null;
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
