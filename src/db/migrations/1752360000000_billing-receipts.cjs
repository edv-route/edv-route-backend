/* eslint-disable camelcase */

/**
 * Billing redesign (2026-08-04): a payment RECEIPT (payment_submission) covers N
 * INVOICES, one per concept — membership + one per tariff week — instead of the
 * single grouped invoice. This REVERTS the "single invoice per cobro" decision
 * (2026-07-28). See docs/decisions/decisions-log.md.
 *
 * Model:
 *  - A receipt GENERATES the invoices it covers (advance / alta with payment).
 *    `invoices.submission_id` points to that receipt. It is NULL for DEBT
 *    invoices emitted WITHOUT a receipt (registration without payment, the weekly
 *    debt engine) — the single exception where invoices exist before any receipt.
 *  - Each charge (membership_payments / subscription_payments) keeps its own
 *    `submission_id` = the receipt that PAID it (added in 1752340000000). So a
 *    reversal can tell an invoice the receipt GENERATED (invoices.submission_id =
 *    receipt → void it) from pre-existing debt the receipt merely SETTLED
 *    (invoices.submission_id NULL but charge.submission_id = receipt → back to owed).
 *
 * Additive changes only.
 */

exports.up = (pgm) => {
  // The receipt that GENERATED this invoice (NULL = debt invoice without receipt).
  pgm.addColumn('invoices', {
    submission_id: { type: 'uuid', references: 'payment_submissions', onDelete: 'SET NULL' },
  });
  pgm.createIndex('invoices', 'submission_id');

  // "N° de pago": a receipt's own continuous number (mirrors invoice_number's
  // single continuous sequence, decision 2026-07-10 — no yearly reset).
  pgm.createSequence('payment_submission_number_seq', { start: '1' });
  pgm.addColumn('payment_submissions', {
    submission_number: {
      type: 'bigint',
      notNull: true,
      default: pgm.func("nextval('payment_submission_number_seq')"),
    },
  });
  pgm.addConstraint('payment_submissions', 'payment_submissions_number_unique', {
    unique: ['submission_number'],
  });

  // Reversal of an APPROVED receipt (money never deleted, regla #7): refund
  // (voids its invoices) or correction (its generated invoices void, pre-existing
  // debt it settled goes back to owed). Keeps who/when/why/type.
  pgm.sql(`ALTER TYPE payment_submission_status ADD VALUE IF NOT EXISTS 'reverted'`);
  pgm.createType('payment_reversal_type', ['refund', 'correction']);
  pgm.addColumns('payment_submissions', {
    reverted_at: { type: 'timestamptz' },
    reverted_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    reversal_type: { type: 'payment_reversal_type' },
    reversal_reason: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('payment_submissions', [
    'reverted_at',
    'reverted_by',
    'reversal_type',
    'reversal_reason',
  ]);
  pgm.dropType('payment_reversal_type');
  // NOTE: PostgreSQL cannot DROP a value from an enum, so 'reverted' stays in
  // payment_submission_status. Harmless.
  pgm.dropConstraint('payment_submissions', 'payment_submissions_number_unique');
  pgm.dropColumn('payment_submissions', 'submission_number');
  pgm.dropSequence('payment_submission_number_seq');
  pgm.dropColumn('invoices', 'submission_id'); // cascades its index
};
