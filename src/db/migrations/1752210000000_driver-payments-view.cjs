/* eslint-disable camelcase */

/**
 * v_driver_payments (design doc v7): unified read model over the two payment
 * tables so histories (per driver and global) come from a single source.
 * Money documents are never deleted - the view exposes refund traces as-is.
 */

exports.up = (pgm) => {
  pgm.createView(
    'v_driver_payments',
    {},
    `
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
           p.name,
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
    `,
  );
};

exports.down = (pgm) => {
  pgm.dropView('v_driver_payments');
};
