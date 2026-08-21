/**
 * SQL fragments that DEFINE the money facts of a driver: what he owes, until
 * when he is covered, and which charge comes next. They live here — not inlined
 * in a repository — because two channels ask the same questions: the admin panel
 * (`drivers.repository.findDetail`) and the driver's own app
 * (`driver-auth.repository.getAccount`). A second, hand-copied definition would
 * drift the day one of the two is fixed, and the app would quietly disagree with
 * the panel about whether a driver is in arrears.
 *
 * Each fragment is parameterized by the alias it must hang from, so the caller's
 * surrounding query keeps its own shape.
 */

/**
 * The driver's headline subscription is the one that rules TODAY: a pending
 * plan change adds a `scheduled` row alongside the active one, and the newest
 * row is not the current one (decision 2026-07-15).
 */
export const SUBSCRIPTION_PRIORITY = `
  CASE ds.status
    WHEN 'active' THEN 1 WHEN 'expired' THEN 2
    WHEN 'pending_payment' THEN 3 ELSE 4
  END
`;

/**
 * What counts as DEBT for a charge row: an OVERDUE tariff week NOT already
 * covered by paid coverage, a week still `pending` but carrying an invoice (the
 * alta debt), or a penalty awaiting payment. A pending week WITHOUT an invoice is
 * the UPCOMING charge, not debt.
 *
 * A pending charge counts only once its week has started. The split used to hang
 * on "pending WITHOUT an invoice = upcoming", which never happens: the engine
 * issues an invoice with every weekly charge, so every week it emitted looked
 * like debt from the moment it was created — days before the driver owed it.
 *
 * The coverage check is the part that used to be missing in half the codebase:
 * after an advance payment (Forma A) the paid coverage moves forward, and a week
 * left marked overdue INSIDE that range is already paid — charging for it again
 * showed the driver a debt that did not exist. The debt engine
 * (`debt-scheduler`) has always applied this rule; everything else must agree.
 *
 * @param alias SQL alias of the charge row (`sp` in most queries).
 */
export const debtChargePredicate = (alias = 'sp'): string => `
  ((${alias}.charge_kind::text = 'period' AND (
      (${alias}.status = 'overdue' AND ${alias}.period_start >= COALESCE(
         (SELECT max(cov.period_end) FROM subscription_payments cov
          WHERE cov.driver_subscription_id = ${alias}.driver_subscription_id
            AND cov.status = 'paid' AND cov.charge_kind::text = 'period'), ${alias}.period_start))
      OR (${alias}.status = 'pending' AND ${alias}.invoice_id IS NOT NULL
          -- ...and its week ALREADY STARTED. A charge issued in advance (the
          -- engine emits Friday for the Monday after) is not owed yet: it is the
          -- UPCOMING charge. A NULL period is the alta debt, not yet anchored to
          -- a date, and that IS owed (decisión de Luis, 2026-08-19).
          AND (${alias}.period_start IS NULL OR ${alias}.period_start <= now()))))
   OR (${alias}.charge_kind::text = 'penalty' AND ${alias}.status IN ('pending', 'overdue')))
`;

/**
 * Próximo cobro: the next weekly charge ALREADY emitted (billing Friday) but not
 * yet due — the solvent driver's "pay in advance" prompt. Null when none exists;
 * `weeklyNextChargeAt` then answers when the engine will emit it.
 *
 * @param driverRef SQL expression resolving to the driver's user id (`d.user_id`
 *   from an outer row, or a bind parameter such as `$1`).
 */
export const upcomingChargeSql = (driverRef: string): string => `
  (SELECT json_build_object(
     'amountUsd', sp.amount_usd::text,
     'periodStart', sp.period_start, 'periodEnd', sp.period_end)
   FROM subscription_payments sp
   JOIN driver_subscriptions ds4 ON ds4.id = sp.driver_subscription_id
   WHERE ds4.driver_id = ${driverRef}
     AND sp.charge_kind::text = 'period' AND sp.status = 'pending'
     AND sp.period_start >= COALESCE(
       (SELECT max(cov.period_end) FROM subscription_payments cov
        WHERE cov.driver_subscription_id = sp.driver_subscription_id
          AND cov.status = 'paid' AND cov.charge_kind::text = 'period'), sp.period_start)
   ORDER BY sp.period_start LIMIT 1)
`;

/**
 * Paid-through: end of the LAST prepaid period (advances included), i.e. the
 * date coverage actually runs out — not merely the end of the running week.
 *
 * @param subscriptionRef SQL expression resolving to the subscription id.
 */
export const paidUntilSql = (subscriptionRef: string): string => `
  (SELECT max(spp.period_end) FROM subscription_payments spp
   WHERE spp.driver_subscription_id = ${subscriptionRef} AND spp.status = 'paid'
     AND spp.charge_kind::text = 'period')
`;

/**
 * Re-derives ONE driver's lifecycle state from his debt, right after the money
 * moved, on the caller's transaction client.
 *
 * The debt engine already does this for everyone once a minute (step 4 of its
 * tick), and that was the only place doing it — so for up to a minute after an
 * admin approved a payment the panel showed «En mora · Debe 0 semana(s) de
 * tarifa», a badge contradicting the very number beside it (found 2026-08-21).
 * The engine stays the authority for time-driven transitions; this closes the
 * gap for the event-driven one, using the SAME rule so the two cannot disagree.
 *
 * Deliberately narrow: it only moves a driver ALREADY in the engine's orbit
 * (approved/overdue/penalized) and never touches a `pending`, `paused` or
 * `suspended` one — those are the admin's, not the debt's. A driver who settled
 * but still has a reactivation moment ahead stays penalized until it arrives.
 */
export async function deriveDriverState(
  executor: { query: (text: string, values: unknown[]) => Promise<unknown> },
  driverId: string,
  capWeeks: number,
): Promise<void> {
  await executor.query(
    `WITH debt AS (
       SELECT count(*)::int AS weeks
         FROM subscription_payments sp
         JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
        WHERE ds.driver_id = $1
          AND sp.status = 'overdue'
          AND (sp.charge_kind <> 'period' OR sp.period_start >= COALESCE(
                (SELECT max(cov.period_end) FROM subscription_payments cov
                  WHERE cov.driver_subscription_id = sp.driver_subscription_id
                    AND cov.status = 'paid' AND cov.charge_kind = 'period'),
                sp.period_start))
     )
     UPDATE drivers d
        SET status = (CASE
              WHEN (SELECT weeks FROM debt) = 0
                   AND (d.reactivates_at IS NULL OR d.reactivates_at <= now()) THEN 'approved'
              WHEN (SELECT weeks FROM debt) = 0 THEN 'penalized'
              WHEN (SELECT weeks FROM debt) <= $2 THEN 'overdue'
              ELSE 'penalized'
            END)::driver_status,
            reactivates_at = CASE
              WHEN (SELECT weeks FROM debt) = 0
                   AND (d.reactivates_at IS NULL OR d.reactivates_at <= now()) THEN NULL
              ELSE d.reactivates_at END
      WHERE d.user_id = $1
        AND d.status::text IN ('approved', 'overdue', 'penalized')
        AND d.tariff_start_set_at IS NOT NULL`,
    [driverId, capWeeks],
  );
}
