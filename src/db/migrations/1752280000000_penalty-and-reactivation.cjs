/* eslint-disable camelcase */

/**
 * Fase B (diseño v8) - B3: penalty charge + deferred reactivation.
 *
 *  - `subscription_payments.charge_kind` distinguishes a tariff week (`period`)
 *    from the penalty fine (`penalty`). Without it a multa would be
 *    indistinguishable from a week of service in the money trail.
 *  - `v_driver_payments` is replaced so the history reads "Penalización"
 *    instead of the plan name for those rows (same columns: REPLACE is safe).
 *  - `drivers.reactivates_at` supports the default reactivation mode: after
 *    settling the debt the driver rejoins on the following Monday (the admin
 *    can still reactivate immediately). NULL = nothing pending.
 *
 * Additive only: existing rows default to `period` and the cobro is unchanged
 * (the debt engine stays behind its master switch).
 */

exports.up = (pgm) => {
  pgm.createType('subscription_charge_kind', ['period', 'penalty']);
  pgm.addColumn('subscription_payments', {
    charge_kind: {
      type: 'subscription_charge_kind',
      notNull: true,
      default: 'period',
    },
  });

  pgm.addColumn('drivers', { reactivates_at: { type: 'timestamptz' } });

  pgm.sql(`
    CREATE OR REPLACE VIEW v_driver_payments AS
    SELECT mp.id,
           mp.driver_id,
           'membership'::text AS kind,
           m.name             AS concept,
           mp.amount_usd,
           mp.status::text    AS status,
           mp.paid_at,
           mp.refunded_at,
           mp.refunded_by,
           NULL::timestamptz  AS period_start,
           NULL::timestamptz  AS period_end,
           mp.invoice_id,
           mp.created_at
    FROM membership_payments mp
    JOIN memberships m ON m.id = mp.membership_id
    UNION ALL
    SELECT sp.id,
           ds.driver_id,
           'subscription'::text,
           CASE WHEN sp.charge_kind = 'penalty' THEN 'Penalización' ELSE p.name END,
           sp.amount_usd,
           sp.status::text,
           sp.paid_at,
           sp.refunded_at,
           sp.refunded_by,
           sp.period_start,
           sp.period_end,
           sp.invoice_id,
           sp.created_at
    FROM subscription_payments sp
    JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
    JOIN subscription_plans p ON p.id = ds.plan_id
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE VIEW v_driver_payments AS
    SELECT mp.id, mp.driver_id, 'membership'::text AS kind, m.name AS concept,
           mp.amount_usd, mp.status::text AS status, mp.paid_at, mp.refunded_at,
           mp.refunded_by, NULL::timestamptz AS period_start,
           NULL::timestamptz AS period_end, mp.invoice_id, mp.created_at
    FROM membership_payments mp
    JOIN memberships m ON m.id = mp.membership_id
    UNION ALL
    SELECT sp.id, ds.driver_id, 'subscription'::text, p.name, sp.amount_usd,
           sp.status::text, sp.paid_at, sp.refunded_at, sp.refunded_by,
           sp.period_start, sp.period_end, sp.invoice_id, sp.created_at
    FROM subscription_payments sp
    JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
    JOIN subscription_plans p ON p.id = ds.plan_id
  `);
  pgm.dropColumn('drivers', 'reactivates_at');
  pgm.dropColumn('subscription_payments', 'charge_kind');
  pgm.dropType('subscription_charge_kind');
};
