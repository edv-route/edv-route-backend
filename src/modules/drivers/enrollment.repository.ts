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
 * a single invoice groups membership + ALL prepaid tariff periods (one invoice
 * for the whole advance payment, decision 2026-07-28). Each period still gets its
 * own subscription_payments coverage row. All inside one transaction.
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
    // A SINGLE invoice groups the whole advance payment: membership + EVERY
    // tariff period (decision 2026-07-28). Paying N weeks up front = one invoice
    // of the total; the per-week subscription_payments rows below still track
    // coverage, so the tariff cycle keeps consuming the advances one week at a time.
    const total = input.membershipPriceUsd + input.planPriceUsd * input.periods;
    const invoice = await this.createInvoice(client, input.driverId, total, input.registeredBy);

    await client.query(
      `INSERT INTO membership_payments
         (driver_id, membership_id, invoice_id, amount_usd, status, paid_at, registered_by)
       VALUES ($1, $2, $3, $4, 'paid', now(), $5)`,
      [input.driverId, input.membershipId, invoice.id, input.membershipPriceUsd, input.registeredBy],
    );

    const { rows: subRows } = await client.query<{ id: string }>(
      `INSERT INTO driver_subscriptions (driver_id, plan_id, status)
       VALUES ($1, $2, 'scheduled') RETURNING id`,
      [input.driverId, input.planId],
    );
    const subscriptionId = subRows[0]!.id;

    // Paid periods: N rows with exact consecutive windows (anchored at approval;
    // stored relative for now - approval shifts them to real dates). They all
    // share the single invoice above.
    for (let i = 0; i < input.periods; i++) {
      await client.query(
        `INSERT INTO subscription_payments
           (driver_subscription_id, invoice_id, period_start, period_end,
            amount_usd, status, paid_at, registered_by)
         VALUES ($1, $2,
                 now() + ($3::interval * $4), now() + ($3::interval * ($4 + 1)),
                 $5, 'paid', now(), $6)`,
        [subscriptionId, invoice.id, input.periodInterval, i, input.planPriceUsd, input.registeredBy],
      );
    }

    await client.query(
      `UPDATE drivers SET registration_step = NULL WHERE user_id = $1`,
      [input.driverId],
    );

    return { invoiceNumbers: [invoice.invoiceNumber] };
  }

  /**
   * Registration WITHOUT payment (option A, 2026-07-30): emits a single UNPAID
   * invoice = membership + ONE tariff week, held as debt. The membership row and
   * the first tariff week are inserted `pending` (no `paid_at`), tied to that
   * invoice; the subscription is `scheduled`. The driver stays pending and cannot
   * be approved until the debt is settled (settling flips these rows to `paid`,
   * and then the invoice reads as paid). Dates anchor at approval, like the paid
   * flow. The debt engine ignores these rows while the driver is not approved.
   */
  async enrollDebtOnClient(
    client: pg.PoolClient,
    input: {
      driverId: string;
      membershipId: number;
      membershipPriceUsd: number;
      planId: number;
      planPriceUsd: number;
      registeredBy: string;
      /** Debt engine on + weekly: anchor the first week to the buying Monday. */
      anchorWeekly: boolean;
      timezone: string;
    },
  ): Promise<{ invoiceNumber: string }> {
    const total = input.membershipPriceUsd + input.planPriceUsd; // membership + 1 week
    const invoice = await this.createInvoice(client, input.driverId, total, input.registeredBy);

    // Membership owed (pending, no paid_at) — occupies the single valid slot.
    await client.query(
      `INSERT INTO membership_payments
         (driver_id, membership_id, invoice_id, amount_usd, status, registered_by)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [input.driverId, input.membershipId, invoice.id, input.membershipPriceUsd, input.registeredBy],
    );

    const { rows: subRows } = await client.query<{ id: string }>(
      `INSERT INTO driver_subscriptions (driver_id, plan_id, status)
       VALUES ($1, $2, 'scheduled') RETURNING id`,
      [input.driverId, input.planId],
    );
    const subscriptionId = subRows[0]!.id;

    // First tariff week owed (pending, no paid_at). Carries the invoice_id so it
    // is recognised as alta debt. When the debt engine anchors weekly, the week
    // is the one the alta BUYS: the next Monday (or this week if today is Monday),
    // so the panel shows the real coverage (e.g. registered a Thu → week starts
    // Monday). Otherwise a placeholder re-anchored at approval.
    await client.query(
      `WITH anchor AS (
         SELECT CASE WHEN $5::boolean THEN
                       (CASE WHEN extract(isodow FROM (now() AT TIME ZONE $6)) = 1
                             THEN date_trunc('week', (now() AT TIME ZONE $6))
                             ELSE date_trunc('week', (now() AT TIME ZONE $6)) + interval '7 days'
                        END) AT TIME ZONE $6
                     ELSE now() END AS start
       )
       INSERT INTO subscription_payments
         (driver_subscription_id, invoice_id, period_start, period_end,
          amount_usd, status, registered_by)
       SELECT $1, $2, a.start, a.start + interval '7 days', $3, 'pending', $4 FROM anchor a`,
      [subscriptionId, invoice.id, input.planPriceUsd, input.registeredBy, input.anchorWeekly, input.timezone],
    );

    await client.query(
      `UPDATE drivers SET registration_step = NULL WHERE user_id = $1`,
      [input.driverId],
    );

    return { invoiceNumber: invoice.invoiceNumber };
  }

  /**
   * Approval: membership stands, tariff starts running. Two anchoring modes:
   *  - Prepaid (default / debt engine off): first period = now -> next midnight
   *    boundary of the interval; the rest are exact consecutive intervals
   *    (decision 2026-07-10).
   *  - Weekly anchored (`anchorWeekly`, debt engine on + weekly plan, v8): every
   *    period is a calendar week [Monday 00:00, next Monday). The alta buys the
   *    week that starts on the NEXT Monday; paying ON a Monday buys the week
   *    already running (decision 2026-07-30). The driver does NOT operate
   *    between the payment and that Monday, so the subscription stays
   *    `scheduled` and the subscription-scheduler activates it when its paid
   *    period begins (the step that already exists since 2026-07-15).
   */
  async approve(
    driverId: string,
    periodInterval: string,
    timezone: string,
    anchorWeekly = false,
  ): Promise<void> {
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
             SELECT date_trunc('day', (now() + $2::interval) AT TIME ZONE $3) AT TIME ZONE $3 AS first_end,
                    -- Next Monday, except when today IS Monday (then, this week).
                    (CASE WHEN extract(isodow FROM (now() AT TIME ZONE $3)) = 1
                          THEN date_trunc('week', (now() AT TIME ZONE $3))
                          ELSE date_trunc('week', (now() AT TIME ZONE $3)) + interval '7 days'
                     END) AT TIME ZONE $3 AS monday
           ), ordered AS (
             SELECT id, row_number() OVER (ORDER BY period_start) - 1 AS idx
             FROM subscription_payments
             WHERE driver_subscription_id = $1 AND status = 'paid'
           )
           UPDATE subscription_payments sp SET
             period_start = CASE
               WHEN $4::boolean THEN a.monday + ($2::interval * o.idx)
               WHEN o.idx = 0 THEN now()
               ELSE a.first_end + ($2::interval * (o.idx - 1)) END,
             period_end = CASE
               WHEN $4::boolean THEN a.monday + ($2::interval * (o.idx + 1))
               ELSE a.first_end + ($2::interval * o.idx) END
           FROM ordered o, anchor a WHERE o.id = sp.id`,
          [sub.id, periodInterval, timezone, anchorWeekly],
        );
        // The first paid week may start in the FUTURE (paid any day but Monday):
        // the tariff is not in force until then, so it stays `scheduled` and the
        // subscription-scheduler flips it to `active` at Monday 00:00.
        await client.query(
          `WITH anchor AS (
             SELECT (CASE WHEN extract(isodow FROM (now() AT TIME ZONE $3)) = 1
                          THEN date_trunc('week', (now() AT TIME ZONE $3))
                          ELSE date_trunc('week', (now() AT TIME ZONE $3)) + interval '7 days'
                     END) AT TIME ZONE $3 AS monday
           )
           UPDATE driver_subscriptions ds SET
             status = (CASE WHEN $4::boolean AND a.monday > now()
                            THEN 'scheduled' ELSE 'active' END)::subscription_status,
             started_at = CASE WHEN $4::boolean AND a.monday > now()
               THEN ds.started_at ELSE now() END,
             current_period_start = CASE WHEN $4::boolean
               THEN a.monday
               ELSE now() END,
             current_period_end = CASE WHEN $4::boolean
               THEN a.monday + $2::interval
               ELSE date_trunc('day', (now() + $2::interval) AT TIME ZONE $3) AT TIME ZONE $3 END
           FROM anchor a
           WHERE ds.id = $1`,
          [sub.id, periodInterval, timezone, anchorWeekly],
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
   * Resume from an administrative pause. Two modes:
   *  - Prepaid (default / debt engine off): the tariff clock was frozen, so shift
   *    every not-yet-consumed period forward by the pause duration
   *    (now() - paused_at) to preserve the remaining coverage.
   *  - Weekly anchored (`anchorWeekly`, debt engine on + weekly, v8): re-anchor
   *    the remaining coverage to consecutive Mondays from the current week's
   *    Monday, so it lines up with the debt engine's weekly grid.
   * Either way the driver flips back to `approved` + available and `paused_at`
   * clears. now() is the transaction timestamp, stable across statements.
   */
  async resume(
    driverId: string,
    timezone = 'America/Caracas',
    anchorWeekly = false,
  ): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{ pausedAt: Date | null }>(
        `SELECT paused_at AS "pausedAt" FROM drivers WHERE user_id = $1 FOR UPDATE`,
        [driverId],
      );
      const pausedAt = rows[0]?.pausedAt;
      if (pausedAt && anchorWeekly) {
        // v8: re-anchor the remaining coverage to Mondays from the current week
        // (not a duration shift), so it matches the debt engine's weekly grid.
        await client.query(
          `WITH anchor AS (
             SELECT date_trunc('week', (now() AT TIME ZONE $2)) AS monday_local
           ), ordered AS (
             SELECT sp.id, (row_number() OVER (ORDER BY sp.period_start) - 1)::int AS idx
             FROM subscription_payments sp
             JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
             WHERE ds.driver_id = $1 AND sp.status = 'paid'
               AND sp.charge_kind = 'period' AND sp.period_end > now()
           )
           UPDATE subscription_payments sp SET
             period_start = (a.monday_local + make_interval(days => o.idx * 7)) AT TIME ZONE $2,
             period_end   = (a.monday_local + make_interval(days => (o.idx + 1) * 7)) AT TIME ZONE $2
           FROM ordered o, anchor a WHERE o.id = sp.id`,
          [driverId, timezone],
        );
        await client.query(
          `UPDATE driver_subscriptions SET
             current_period_start = date_trunc('week', (now() AT TIME ZONE $2)) AT TIME ZONE $2,
             current_period_end = (date_trunc('week', (now() AT TIME ZONE $2)) + interval '7 days') AT TIME ZONE $2
           WHERE driver_id = $1 AND status = 'active'`,
          [driverId, timezone],
        );
      } else if (pausedAt) {
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
    /** v8: anchor weekly periods to Monday (debt engine on + weekly plan). */
    anchorWeekly: boolean;
    registeredBy: string;
  }): Promise<{ invoiceNumbers: string[] }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Anchor base. Weekly-anchored (v8): the Monday of the current week when
      // reactivating or when there is no coverage, otherwise chain after the last
      // paid period (already Monday-aligned). Prepaid (default): from now / the
      // next midnight boundary, as before.
      const { rows: anchorRows } = await client.query<{ base: Date }>(
        input.reactivate
          ? `SELECT CASE WHEN $4::boolean
                        THEN date_trunc('week', (now() AT TIME ZONE $3)) AT TIME ZONE $3
                        ELSE date_trunc('day', (now() + $2::interval) AT TIME ZONE $3) AT TIME ZONE $3 END AS base
             FROM driver_subscriptions WHERE id = $1 FOR UPDATE`
          : `SELECT COALESCE(
               (SELECT max(period_end) FROM subscription_payments
                WHERE driver_subscription_id = $1 AND status = 'paid'),
               CASE WHEN $4::boolean
                    THEN date_trunc('week', (now() AT TIME ZONE $3)) AT TIME ZONE $3
                    ELSE date_trunc('day', (now() + $2::interval) AT TIME ZONE $3) AT TIME ZONE $3 END
             ) AS base
             FROM driver_subscriptions WHERE id = $1 FOR UPDATE`,
        [input.subscriptionId, input.periodInterval, input.timezone, input.anchorWeekly],
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
                   CASE WHEN $9::boolean THEN $3::timestamptz + ($5::interval * $4)
                        WHEN $7::boolean
                        THEN CASE WHEN $4 = 0 THEN now()
                                  ELSE $3::timestamptz + ($5::interval * ($4 - 1)) END
                        ELSE $3::timestamptz + ($5::interval * $4) END,
                   CASE WHEN $9::boolean THEN $3::timestamptz + ($5::interval * ($4 + 1))
                        WHEN $7::boolean
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
            input.anchorWeekly,
          ],
        );
      }

      if (input.reactivate) {
        await client.query(
          `UPDATE driver_subscriptions SET
             status = 'active',
             current_period_start = CASE WHEN $3::boolean THEN $2::timestamptz ELSE now() END,
             current_period_end = CASE WHEN $3::boolean
               THEN $2::timestamptz + interval '7 days' ELSE $2::timestamptz END
           WHERE id = $1`,
          [input.subscriptionId, base, input.anchorWeekly],
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
    /** v8: anchor weekly periods to Monday (debt engine on + weekly plan). */
    anchorWeekly: boolean;
    registeredBy: string;
  }): Promise<{ invoiceNumbers: string[]; startsAt: Date }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const immediate = input.mode === 'immediate';
      // Anchor base: weekly-anchored (v8) uses the current week's Monday for an
      // immediate change or when no coverage remains; otherwise chains after the
      // last paid period (already Monday-aligned). Prepaid keeps the old behaviour.
      const { rows: anchorRows } = await client.query<{ base: Date }>(
        immediate
          ? `SELECT CASE WHEN $4::boolean
                        THEN date_trunc('week', (now() AT TIME ZONE $3)) AT TIME ZONE $3
                        ELSE date_trunc('day', (now() + $2::interval) AT TIME ZONE $3) AT TIME ZONE $3 END AS base
             FROM driver_subscriptions WHERE id = $1 FOR UPDATE`
          : `SELECT COALESCE(
               (SELECT max(period_end) FROM subscription_payments
                WHERE driver_subscription_id = $1 AND status = 'paid'),
               CASE WHEN $4::boolean
                    THEN date_trunc('week', (now() AT TIME ZONE $3)) AT TIME ZONE $3
                    ELSE date_trunc('day', (now() + $2::interval) AT TIME ZONE $3) AT TIME ZONE $3 END
             ) AS base
             FROM driver_subscriptions WHERE id = $1 FOR UPDATE`,
        [input.currentSubscriptionId, input.periodInterval, input.timezone, input.anchorWeekly],
      );
      const base = anchorRows[0]!.base;

      // $3 is cast explicitly: it feeds an enum column and a text comparison.
      const { rows: subRows } = await client.query<{ id: string }>(
        `INSERT INTO driver_subscriptions
           (driver_id, plan_id, status, started_at, current_period_start, current_period_end)
         VALUES ($1, $2, $3::subscription_status,
                 CASE WHEN $3::text = 'active' THEN now() END,
                 CASE WHEN $3::text = 'active' THEN
                      CASE WHEN $5::boolean THEN $4::timestamptz ELSE now() END END,
                 CASE WHEN $3::text = 'active' THEN
                      CASE WHEN $5::boolean THEN $4::timestamptz + interval '7 days'
                           ELSE $4::timestamptz END END)
         RETURNING id`,
        [input.driverId, input.newPlanId, immediate ? 'active' : 'scheduled', base, input.anchorWeekly],
      );
      const newSubscriptionId = subRows[0]!.id;

      const invoiceNumbers: string[] = [];
      for (let i = 0; i < input.periods; i++) {
        const invoice = await this.createInvoice(
          client, input.driverId, input.planPriceUsd, input.registeredBy,
        );
        invoiceNumbers.push(invoice.invoiceNumber);
        // Weekly-anchored: Monday-based windows. Immediate (prepaid): first period
        // runs from now to the aligned base.
        await client.query(
          `INSERT INTO subscription_payments
             (driver_subscription_id, invoice_id, period_start, period_end,
              amount_usd, status, paid_at, registered_by)
           VALUES ($1, $2,
                   CASE WHEN $9::boolean THEN $3::timestamptz + ($5::interval * $4)
                        WHEN $7::boolean
                        THEN CASE WHEN $4 = 0 THEN now()
                                  ELSE $3::timestamptz + ($5::interval * ($4 - 1)) END
                        ELSE $3::timestamptz + ($5::interval * $4) END,
                   CASE WHEN $9::boolean THEN $3::timestamptz + ($5::interval * ($4 + 1))
                        WHEN $7::boolean
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
            input.anchorWeekly,
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
   * External payment (design v8 + option A, 2026-07-30): the driver settled with
   * the admin outside the system. Settles ALL the debt in one transaction — the
   * MEMBERSHIP (alta), the overdue tariff weeks (arrears), the penalty fine and
   * the alta's first week — marking each `paid` with `paid_at = now()`. Charges
   * that already carry a debt invoice (the alta) keep it (that invoice now reads
   * as paid); engine arrears without an invoice get ONE fresh invoice grouping
   * them (trace, regla de oro #7). A pending week WITHOUT an invoice is the
   * upcoming charge, NOT debt, and is left untouched. Returns null when nothing
   * is outstanding. The debt engine then derives the state out of overdue/penalized.
   */
  async registerExternalPayment(input: {
    driverId: string;
    registeredBy: string;
  }): Promise<{ invoiceNumber: string; settledCharges: number; totalUsd: string } | null> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      type Row = { id: string; amountUsd: string; invoiceId: string | null };
      const { rows: charges } = await client.query<Row>(
        `SELECT sp.id, sp.amount_usd AS "amountUsd", sp.invoice_id AS "invoiceId"
         FROM subscription_payments sp
         JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
         WHERE ds.driver_id = $1
           AND (sp.status = 'overdue' OR (sp.status = 'pending' AND sp.invoice_id IS NOT NULL))
         FOR UPDATE OF sp`,
        [input.driverId],
      );
      const { rows: memberships } = await client.query<Row>(
        `SELECT id, amount_usd AS "amountUsd", invoice_id AS "invoiceId"
         FROM membership_payments
         WHERE driver_id = $1 AND status = 'pending'
         FOR UPDATE`,
        [input.driverId],
      );
      if (charges.length === 0 && memberships.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      // Engine arrears without an invoice get ONE fresh invoice grouping them.
      const orphans = charges.filter((c) => !c.invoiceId);
      let orphanInvoice: { id: string; invoiceNumber: string } | null = null;
      if (orphans.length > 0) {
        const orphanTotal = orphans.reduce((sum, c) => sum + Number(c.amountUsd), 0);
        orphanInvoice = await this.createInvoice(client, input.driverId, orphanTotal, input.registeredBy);
        await client.query(
          `UPDATE subscription_payments
              SET status = 'paid', paid_at = now(), invoice_id = $2, registered_by = $3
            WHERE id = ANY($1::uuid[])`,
          [orphans.map((c) => c.id), orphanInvoice.id, input.registeredBy],
        );
      }
      // Charges that already carry a debt invoice (alta): just mark paid.
      const invoiced = charges.filter((c) => c.invoiceId).map((c) => c.id);
      if (invoiced.length > 0) {
        await client.query(
          `UPDATE subscription_payments
              SET status = 'paid', paid_at = now(), registered_by = $2
            WHERE id = ANY($1::uuid[])`,
          [invoiced, input.registeredBy],
        );
      }
      if (memberships.length > 0) {
        await client.query(
          `UPDATE membership_payments
              SET status = 'paid', paid_at = now(), registered_by = $2
            WHERE id = ANY($1::uuid[])`,
          [memberships.map((c) => c.id), input.registeredBy],
        );
      }

      // Primary invoice (for payment meta + receipt): the fresh arrears invoice
      // if any, else the alta invoice the settled charges already carry.
      const altaInvoiceId =
        charges.find((c) => c.invoiceId)?.invoiceId ?? memberships.find((c) => c.invoiceId)?.invoiceId ?? null;
      let invoiceNumber = orphanInvoice?.invoiceNumber ?? '';
      if (!invoiceNumber && altaInvoiceId) {
        const { rows } = await client.query<{ n: string }>(
          `SELECT invoice_number::text AS n FROM invoices WHERE id = $1`,
          [altaInvoiceId],
        );
        invoiceNumber = rows[0]?.n ?? '';
      }

      const total = [...charges, ...memberships].reduce((sum, c) => sum + Number(c.amountUsd), 0);

      await client.query('COMMIT');
      return {
        invoiceNumber,
        settledCharges: charges.length + memberships.length,
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
    meta: {
      paymentMethodId: number | null;
      reference: string | null;
      payerBank: string | null;
      paidOn: string | null;
      payerPhone: string | null;
      payerId: string | null;
      payerAccount: string | null;
    },
  ): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE invoices
          SET payment_method_id = $2, payment_reference = $3, payer_bank = $4,
              paid_on = $5, payer_phone = $6, payer_id = $7, payer_account = $8
        WHERE invoice_number = $1::bigint AND status = 'issued'
        RETURNING id`,
      [
        invoiceNumber, meta.paymentMethodId, meta.reference, meta.payerBank,
        meta.paidOn, meta.payerPhone, meta.payerId, meta.payerAccount,
      ],
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
