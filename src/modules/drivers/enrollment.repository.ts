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
  /** Admin who registered (panel); null for self-service app registrations. */
  registeredBy: string | null;
  /** v9: links the created charges to the approved submission (null for the legacy path). */
  submissionId?: string | null;
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
    // Billing redesign (2026-08-04): the alta RECEIPT GENERATES its invoices when
    // it is CREATED — ONE per concept (membership + one per week), all `pending`
    // (owed) and linked to the receipt via `submissionId`. While the receipt is
    // pending they read as debt with their N° already assigned; approval flips
    // them to `paid` (markReceiptChargesPaid); a rejection leaves them owed
    // (decision 2026-08-04). This REVERTS the single-invoice decision (2026-07-28);
    // the payment details live on the receipt, not on each invoice.
    const submissionId = input.submissionId ?? null;

    const membershipInvoice = await this.createInvoice(
      client, input.driverId, input.membershipPriceUsd, input.registeredBy, submissionId,
    );
    await client.query(
      `INSERT INTO membership_payments
         (driver_id, membership_id, invoice_id, amount_usd, status, registered_by, submission_id)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
      [input.driverId, input.membershipId, membershipInvoice.id, input.membershipPriceUsd, input.registeredBy, submissionId],
    );

    const { rows: subRows } = await client.query<{ id: string }>(
      `INSERT INTO driver_subscriptions (driver_id, plan_id, status)
       VALUES ($1, $2, 'scheduled') RETURNING id`,
      [input.driverId, input.planId],
    );
    const subscriptionId = subRows[0]!.id;

    // Owed periods: N rows WITHOUT dates. Period windows are anchored only when
    // the admin sets the tariff start (enrollment.approve) — no provisional dates
    // exist beforehand (solicitudes-app, 2026-08-11). Each week is its OWN invoice.
    const invoiceNumbers = [membershipInvoice.invoiceNumber];
    for (let i = 0; i < input.periods; i++) {
      const weekInvoice = await this.createInvoice(
        client, input.driverId, input.planPriceUsd, input.registeredBy, submissionId,
      );
      invoiceNumbers.push(weekInvoice.invoiceNumber);
      await client.query(
        `INSERT INTO subscription_payments
           (driver_subscription_id, invoice_id, period_start, period_end,
            amount_usd, status, registered_by, submission_id)
         VALUES ($1, $2, NULL, NULL, $3, 'pending', $4, $5)`,
        [subscriptionId, weekInvoice.id, input.planPriceUsd, input.registeredBy, submissionId],
      );
    }

    await client.query(
      `UPDATE drivers SET registration_step = NULL WHERE user_id = $1`,
      [input.driverId],
    );

    return { invoiceNumbers };
  }

  /**
   * Approval of an alta receipt: flips the receipt's owed charges (generated
   * `pending` by enrollOnClient when the receipt was created) to `paid`. The
   * driver becomes approvable once its debt reaches zero.
   */
  async markReceiptChargesPaid(client: pg.PoolClient, submissionId: string): Promise<void> {
    await client.query(
      `UPDATE membership_payments SET status = 'paid', paid_at = now()
       WHERE submission_id = $1 AND status = 'pending'`,
      [submissionId],
    );
    await client.query(
      `UPDATE subscription_payments SET status = 'paid', paid_at = now()
       WHERE submission_id = $1 AND status = 'pending'`,
      [submissionId],
    );
  }

  /**
   * Reverses an APPROVED receipt's money effects (billing redesign 2026-08-04):
   *  - invoices this receipt GENERATED → voided; their charges → refunded (money
   *    never deleted, regla #7).
   *  - pre-existing debt it only SETTLED (invoice not generated by it) → back to
   *    `pending` (owed) and unlinked, so a fresh receipt can claim it.
   * If the reversal undoes the driver's membership (alta), he returns to `pending`.
   * The receipt row is flipped to `reverted` (with the trace) by the caller.
   */
  async reverseReceipt(
    client: pg.PoolClient,
    input: { submissionId: string; adminId: string },
  ): Promise<{ voidedInvoices: number; restoredCharges: number }> {
    const { submissionId, adminId } = input;

    // Charges of invoices this receipt GENERATED → refunded (before voiding the
    // invoices, while the "generated by" link still resolves).
    await client.query(
      `UPDATE membership_payments mp SET status = 'refunded', refunded_at = now(), refunded_by = $2
       FROM invoices i WHERE i.id = mp.invoice_id AND i.submission_id = $1 AND mp.status <> 'refunded'`,
      [submissionId, adminId],
    );
    await client.query(
      `UPDATE subscription_payments sp SET status = 'refunded', refunded_at = now(), refunded_by = $2
       FROM invoices i WHERE i.id = sp.invoice_id AND i.submission_id = $1 AND sp.status <> 'refunded'`,
      [submissionId, adminId],
    );
    const voided = await client.query(
      `UPDATE invoices SET status = 'voided', voided_at = now(), voided_by = $2
       WHERE submission_id = $1 AND status <> 'voided'`,
      [submissionId, adminId],
    );

    // Pre-existing debt the receipt only SETTLED → back to owed; unlink it.
    const rm = await client.query(
      `UPDATE membership_payments mp SET status = 'pending', paid_at = NULL, submission_id = NULL
       WHERE mp.submission_id = $1 AND mp.status = 'paid'
         AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = mp.invoice_id AND i.submission_id = $1)`,
      [submissionId],
    );
    const rs = await client.query(
      `UPDATE subscription_payments sp SET status = 'pending', paid_at = NULL, submission_id = NULL
       WHERE sp.submission_id = $1 AND sp.status = 'paid'
         AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = sp.invoice_id AND i.submission_id = $1)`,
      [submissionId],
    );

    // Lost his membership (alta) → the driver falls back to pending.
    await client.query(
      `UPDATE drivers d SET status = 'pending'
       WHERE d.user_id = (SELECT driver_id FROM payment_submissions WHERE id = $1)
         AND d.status = 'approved'
         AND NOT EXISTS (SELECT 1 FROM membership_payments mp
                         WHERE mp.driver_id = d.user_id AND mp.status = 'paid')`,
      [submissionId],
    );

    return {
      voidedInvoices: voided.rowCount ?? 0,
      restoredCharges: (rm.rowCount ?? 0) + (rs.rowCount ?? 0),
    };
  }

  /**
   * Registration WITHOUT payment (option A, 2026-07-30): emits a single UNPAID
   * invoice = membership + ONE tariff week, held as debt. The membership row and
   * the first tariff week are inserted `pending` (no `paid_at`), tied to that
   * invoice; the subscription is `scheduled`. The driver stays pending and cannot
   * be approved until the debt is settled (settling flips these rows to `paid`,
   * and then the invoice reads as paid). The week is created WITHOUT period dates
   * (NULL): they are anchored only when the tariff start is set (startTariff), so
   * no provisional dates exist beforehand (solicitudes-app 2026-08-11). The debt
   * engine ignores these rows while the driver has no tariff start set.
   */
  async enrollDebtOnClient(
    client: pg.PoolClient,
    input: {
      driverId: string;
      membershipId: number;
      membershipPriceUsd: number;
      planId: number;
      planPriceUsd: number;
      /** Admin who registered (panel); null for self-service app registrations. */
      registeredBy: string | null;
    },
  ): Promise<{ invoiceNumbers: string[] }> {
    // Billing redesign (2026-08-04): TWO debt invoices, one per concept
    // (membership + first tariff week), with NO receipt — the single exception
    // where invoices exist before any payment. Both pending until a receipt cancels
    // them; the driver cannot be approved while either is owed.
    const membershipInvoice = await this.createInvoice(
      client, input.driverId, input.membershipPriceUsd, input.registeredBy,
    );
    await client.query(
      `INSERT INTO membership_payments
         (driver_id, membership_id, invoice_id, amount_usd, status, registered_by)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [input.driverId, input.membershipId, membershipInvoice.id, input.membershipPriceUsd, input.registeredBy],
    );

    const { rows: subRows } = await client.query<{ id: string }>(
      `INSERT INTO driver_subscriptions (driver_id, plan_id, status)
       VALUES ($1, $2, 'scheduled') RETURNING id`,
      [input.driverId, input.planId],
    );
    const subscriptionId = subRows[0]!.id;

    // First tariff week owed (pending, no paid_at), its OWN invoice. When the debt
    // engine anchors weekly, the week is the one the alta BUYS: the next Monday (or
    // this week if today is Monday), so the panel shows the real coverage (e.g.
    // registered a Thu → week starts Monday). Otherwise a placeholder re-anchored
    // at approval.
    const weekInvoice = await this.createInvoice(
      client, input.driverId, input.planPriceUsd, input.registeredBy,
    );
    await client.query(
      `INSERT INTO subscription_payments
         (driver_subscription_id, invoice_id, period_start, period_end,
          amount_usd, status, registered_by)
       VALUES ($1, $2, NULL, NULL, $3, 'pending', $4)`,
      [subscriptionId, weekInvoice.id, input.planPriceUsd, input.registeredBy],
    );

    await client.query(
      `UPDATE drivers SET registration_step = NULL WHERE user_id = $1`,
      [input.driverId],
    );

    return { invoiceNumbers: [membershipInvoice.invoiceNumber, weekInvoice.invoiceNumber] };
  }

  /**
   * Approval (2026-08-09): the admin chooses WHEN the tariff starts.
   *  - Prepaid (default / debt engine off): first period = now -> next midnight
   *    boundary of the interval; the rest are exact consecutive intervals
   *    (decision 2026-07-10). `nextMonday` has no effect (no Monday grid).
   *  - Weekly anchored (`anchorWeekly`, debt engine on + weekly plan): every period
   *    is a calendar week [Monday 00:00, next Monday). Two start modes:
   *      · `nextMonday=false` ("empezar ya"): anchored to the CURRENT week's Monday,
   *        tariff `active` at once; a mid-week approval keeps the days already
   *        elapsed (next charge on the normal Friday). Same as a reactivated driver.
   *      · `nextMonday=true` ("próximo lunes"): anchored to the FOLLOWING Monday —
   *        always next week, even when today is Monday (so "empezar ya" covers this
   *        Monday). That Monday is always in the future, so the subscription and the
   *        driver stay `scheduled` (programado, not operative) until the
   *        scheduled-activation job flips both on that Monday.
   */
  async approve(
    driverId: string,
    periodInterval: string,
    timezone: string,
    anchorWeekly = false,
    nextMonday = false,
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
                    -- "empezar ya" → current week's Monday; "próximo lunes" → the
                    -- FOLLOWING Monday (next week even when today is Monday).
                    (CASE WHEN $5::boolean
                          THEN date_trunc('week', (now() AT TIME ZONE $3)) + interval '7 days'
                          ELSE date_trunc('week', (now() AT TIME ZONE $3)) END) AT TIME ZONE $3 AS monday
           ), ordered AS (
             -- Order by creation (period_start is NULL until this anchor runs).
             SELECT id, row_number() OVER (ORDER BY created_at, id) - 1 AS idx
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
          [sub.id, periodInterval, timezone, anchorWeekly, nextMonday],
        );
        // A future anchor Monday (only reachable in weekly + "próximo lunes") keeps
        // the subscription `scheduled` until the activation job runs; otherwise the
        // Monday is <= now and the tariff is `active` at once.
        await client.query(
          `WITH anchor AS (
             SELECT (CASE WHEN $5::boolean
                          THEN date_trunc('week', (now() AT TIME ZONE $3)) + interval '7 days'
                          ELSE date_trunc('week', (now() AT TIME ZONE $3)) END) AT TIME ZONE $3 AS monday
           )
           UPDATE driver_subscriptions ds SET
             status = CASE WHEN $4::boolean AND a.monday > now()
                           THEN 'scheduled'::subscription_status
                           ELSE 'active'::subscription_status END,
             started_at = CASE WHEN $4::boolean AND a.monday > now() THEN NULL ELSE now() END,
             current_period_start = CASE WHEN $4::boolean THEN a.monday ELSE now() END,
             current_period_end = CASE WHEN $4::boolean
               THEN a.monday + $2::interval
               ELSE date_trunc('day', (now() + $2::interval) AT TIME ZONE $3) AT TIME ZONE $3 END
           FROM anchor a
           WHERE ds.id = $1`,
          [sub.id, periodInterval, timezone, anchorWeekly, nextMonday],
        );
      }

      // A future-Monday weekly approval → `scheduled` (programado), not operative
      // yet; every other case → `approved` + available (availability plane, 2026-07-23).
      await client.query(
        `WITH anchor AS (
           SELECT (CASE WHEN $3::boolean
                        THEN date_trunc('week', (now() AT TIME ZONE $2)) + interval '7 days'
                        ELSE date_trunc('week', (now() AT TIME ZONE $2)) END) AT TIME ZONE $2 AS monday
         )
         UPDATE drivers d SET
           status = CASE WHEN $4::boolean AND a.monday > now()
                         THEN 'scheduled'::driver_status
                         ELSE 'approved'::driver_status END,
           is_available = NOT ($4::boolean AND a.monday > now()),
           -- Decoupled tariff start (solicitudes-app): anchoring the tariff IS
           -- setting the start, atomically. From here the debt engine bills him.
           tariff_start_set_at = now()
         FROM anchor a
         WHERE d.user_id = $1`,
        [driverId, timezone, nextMonday, anchorWeekly],
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
   * Flips a `scheduled` (programado) driver to operative once his start Monday has
   * arrived: his scheduled subscription → `active` and the driver → `approved` +
   * available. Idempotent (only touches a still-scheduled pair). Driven by the
   * scheduled-activation job.
   */
  async activateScheduled(driverId: string): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE driver_subscriptions
            SET status = 'active'::subscription_status, started_at = COALESCE(started_at, now())
          WHERE driver_id = $1 AND status = 'scheduled'`,
        [driverId],
      );
      await client.query(
        `UPDATE drivers SET status = 'approved', is_available = true
          WHERE user_id = $1 AND status::text = 'scheduled'`,
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
   * Settles a driver's debt on a caller-provided client: marks the selected (or
   * ALL) owed charges `paid` and links them to the receipt. Billing redesign
   * (2026-08-04): each owed charge already carries its OWN invoice (registration
   * without payment; and the weekly engine once migrated), so this NO LONGER
   * emits a grouped invoice — the charge's own invoice simply reads as paid.
   *
   * `invoiceIds` restricts the settlement to those invoices (PARTIAL payment;
   * each invoice is one concept, paid in full) — null settles every owed charge.
   * Legacy engine arrears WITHOUT an invoice still get one fresh invoice EACH
   * (one per concept; transition until the weekly engine emits per-week invoices).
   * A pending week WITHOUT an invoice is the upcoming charge, NOT debt, and is
   * left untouched. Returns null when nothing matches. `submissionId` links the
   * settled charges to the receipt (null for the legacy direct external payment).
   */
  async settleDebtOnClient(
    client: pg.PoolClient,
    input: {
      driverId: string;
      registeredBy: string;
      submissionId?: string | null;
      invoiceIds?: string[] | null;
    },
  ): Promise<{ settledCharges: number; totalUsd: string } | null> {
    const submissionId = input.submissionId ?? null;
    const selected = input.invoiceIds && input.invoiceIds.length > 0 ? input.invoiceIds : null;
    type Row = { id: string; amountUsd: string; invoiceId: string | null };
    const { rows: charges } = await client.query<Row>(
      `SELECT sp.id, sp.amount_usd AS "amountUsd", sp.invoice_id AS "invoiceId"
       FROM subscription_payments sp
       JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
       WHERE ds.driver_id = $1
         AND (sp.status = 'overdue' OR (sp.status = 'pending' AND sp.invoice_id IS NOT NULL))
         AND ($2::uuid[] IS NULL OR sp.invoice_id = ANY($2::uuid[]))
       FOR UPDATE OF sp`,
      [input.driverId, selected],
    );
    const { rows: memberships } = await client.query<Row>(
      `SELECT id, amount_usd AS "amountUsd", invoice_id AS "invoiceId"
       FROM membership_payments
       WHERE driver_id = $1 AND status = 'pending'
         AND ($2::uuid[] IS NULL OR invoice_id = ANY($2::uuid[]))
       FOR UPDATE`,
      [input.driverId, selected],
    );
    if (charges.length === 0 && memberships.length === 0) {
      return null;
    }

    // Legacy engine arrears without an invoice get one fresh invoice EACH (one per
    // concept). Removed once the weekly engine emits per-week invoices.
    for (const orphan of charges.filter((c) => !c.invoiceId)) {
      const inv = await this.createInvoice(
        client, input.driverId, Number(orphan.amountUsd), input.registeredBy, submissionId,
      );
      await client.query(
        `UPDATE subscription_payments
            SET status = 'paid', paid_at = now(), invoice_id = $2,
                registered_by = $3, submission_id = $4
          WHERE id = $1`,
        [orphan.id, inv.id, input.registeredBy, submissionId],
      );
    }
    // Charges that already carry their own invoice: just mark paid + link receipt.
    const invoiced = charges.filter((c) => c.invoiceId).map((c) => c.id);
    if (invoiced.length > 0) {
      await client.query(
        `UPDATE subscription_payments
            SET status = 'paid', paid_at = now(), registered_by = $2, submission_id = $3
          WHERE id = ANY($1::uuid[])`,
        [invoiced, input.registeredBy, submissionId],
      );
    }
    if (memberships.length > 0) {
      await client.query(
        `UPDATE membership_payments
            SET status = 'paid', paid_at = now(), registered_by = $2, submission_id = $3
          WHERE id = ANY($1::uuid[])`,
        [memberships.map((c) => c.id), input.registeredBy, submissionId],
      );
    }

    const total = [...charges, ...memberships].reduce((sum, c) => sum + Number(c.amountUsd), 0);
    return {
      settledCharges: charges.length + memberships.length,
      totalUsd: total.toFixed(2),
    };
  }

  /**
   * Settles an ADVANCE (renewal/prepay of N tariff weeks) on a caller-provided
   * client, as part of the v9 approval transaction. Same anchoring rule as
   * `renew`, but emits ONE invoice grouping the N weeks (fixing the old
   * "N invoices per advance" bug) and links them to the approved submission.
   */
  async settleAdvanceOnClient(
    client: pg.PoolClient,
    input: {
      subscriptionId: string;
      driverId: string;
      planPriceUsd: number;
      periods: number;
      periodInterval: string;
      timezone: string;
      reactivate: boolean;
      anchorWeekly: boolean;
      registeredBy: string;
      submissionId: string;
    },
  ): Promise<{ invoiceNumbers: string[] }> {
    // Anchor base: weekly-anchored uses the current week's Monday when
    // reactivating or when there is no coverage, else chains after the last paid
    // period; prepaid uses now / the next midnight boundary (identical to renew).
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

    // Billing redesign (2026-08-04): ONE invoice per prepaid week, all linked to
    // the receipt that generated them (payment details live on the receipt).
    const invoiceNumbers: string[] = [];
    for (let i = 0; i < input.periods; i++) {
      const weekInvoice = await this.createInvoice(
        client, input.driverId, input.planPriceUsd, input.registeredBy, input.submissionId,
      );
      invoiceNumbers.push(weekInvoice.invoiceNumber);
      await client.query(
        `INSERT INTO subscription_payments
           (driver_subscription_id, invoice_id, period_start, period_end,
            amount_usd, status, paid_at, registered_by, submission_id)
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
                 $6, 'paid', now(), $8, $10)`,
        [
          input.subscriptionId, weekInvoice.id, base, i, input.periodInterval,
          input.planPriceUsd, input.reactivate, input.registeredBy, input.anchorWeekly,
          input.submissionId,
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

    return { invoiceNumbers };
  }

  /**
   * Settles a PLAN CHANGE on a caller-provided client (v9 approval): creates the
   * new subscription and prepays N weeks in ONE invoice, linking them to the
   * submission. `scheduled` starts when the current coverage runs out; `immediate`
   * starts now and cancels the old subscription. Same windows as `changePlan`.
   */
  async settleChangePlanOnClient(
    client: pg.PoolClient,
    input: {
      driverId: string;
      currentSubscriptionId: string;
      newPlanId: number;
      planPriceUsd: number;
      periods: number;
      periodInterval: string;
      timezone: string;
      mode: 'scheduled' | 'immediate';
      anchorWeekly: boolean;
      registeredBy: string;
      submissionId: string;
    },
  ): Promise<{ invoiceNumbers: string[]; startsAt: Date }> {
    const immediate = input.mode === 'immediate';
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

    // Billing redesign (2026-08-04): ONE invoice per prepaid week of the new plan,
    // all linked to the receipt that generated them.
    const invoiceNumbers: string[] = [];
    for (let i = 0; i < input.periods; i++) {
      const weekInvoice = await this.createInvoice(
        client, input.driverId, input.planPriceUsd, input.registeredBy, input.submissionId,
      );
      invoiceNumbers.push(weekInvoice.invoiceNumber);
      await client.query(
        `INSERT INTO subscription_payments
           (driver_subscription_id, invoice_id, period_start, period_end,
            amount_usd, status, paid_at, registered_by, submission_id)
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
                 $6, 'paid', now(), $8, $10)`,
        [
          newSubscriptionId, weekInvoice.id, base, i, input.periodInterval,
          input.planPriceUsd, immediate, input.registeredBy, input.anchorWeekly,
          input.submissionId,
        ],
      );
    }

    if (immediate) {
      await client.query(
        `UPDATE driver_subscriptions SET status = 'cancelled', cancelled_at = now()
         WHERE id = $1 AND status <> 'cancelled'`,
        [input.currentSubscriptionId],
      );
    }

    return { invoiceNumbers, startsAt: base };
  }

  /**
   * Rejection: refunds PAID charges and cancels OWED ones (the alta debt of a
   * registration without payment, or arrears), and voids every related invoice
   * (numbers kept). A rejected driver is left with NO leftover debt/charges, so
   * the profile shows nothing pending for him.
   */
  async reject(driverId: string, adminId: string): Promise<RejectionResult> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const mp = await client.query(
        `UPDATE membership_payments SET status = 'refunded', refunded_at = now(), refunded_by = $2
         WHERE driver_id = $1 AND status IN ('paid', 'pending')`,
        [driverId, adminId],
      );
      const sp = await client.query(
        `UPDATE subscription_payments sp SET status = 'refunded', refunded_at = now(), refunded_by = $2
         FROM driver_subscriptions ds
         WHERE sp.driver_subscription_id = ds.id AND ds.driver_id = $1
           AND sp.status IN ('paid', 'pending', 'overdue')`,
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

  /**
   * Creates ONE invoice for ONE concept (membership or a single tariff week) —
   * the billing redesign emits an invoice per charge, not a grouped one
   * (2026-08-04). `submissionId` links it to the receipt that GENERATED it (null
   * for debt invoices emitted without a receipt: registration without payment,
   * weekly debt engine).
   */
  private async createInvoice(
    client: pg.PoolClient,
    driverId: string,
    totalUsd: number,
    registeredBy: string | null,
    submissionId: string | null = null,
  ): Promise<{ id: string; invoiceNumber: string }> {
    const { rows } = await client.query<{ id: string; invoiceNumber: string }>(
      `INSERT INTO invoices (driver_id, total_usd, registered_by, submission_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, invoice_number::text AS "invoiceNumber"`,
      [driverId, totalUsd, registeredBy, submissionId],
    );
    return rows[0]!;
  }
}
