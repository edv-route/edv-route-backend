/* eslint-disable camelcase */

/**
 * Payment submissions carry a PURPOSE + CONTEXT (v9, 2B): what the payment is
 * for and the parameters approval needs. `debt` (2A) settles outstanding debt
 * and needs no context; `advance` renews/prepays N weeks of the current tariff
 * (context: subscriptionId, planId, periods) and, on approval, emits ONE invoice
 * grouping the N weeks — fixing the old "N invoices per advance" behaviour.
 * `enroll` / `change_plan` are reserved for the alta and plan change (wired with
 * their UI later). Additive; existing rows default to `debt` / `{}`.
 */

exports.up = (pgm) => {
  pgm.addColumns('payment_submissions', {
    purpose: { type: 'text', notNull: true, default: 'debt' },
    context: { type: 'jsonb', notNull: true, default: '{}' },
  });
  pgm.addConstraint('payment_submissions', 'payment_submissions_purpose_check', {
    check: `purpose IN ('debt', 'advance', 'enroll', 'change_plan')`,
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('payment_submissions', 'payment_submissions_purpose_check');
  pgm.dropColumns('payment_submissions', ['purpose', 'context']);
};
