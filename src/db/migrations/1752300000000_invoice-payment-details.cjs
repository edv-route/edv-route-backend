/* eslint-disable camelcase */

/**
 * Payment details on the invoice (Pieza 2): which registered method was used,
 * the transfer reference, the payer's bank (banco emisor) and the receipt
 * (comprobante) file in Storage. The amount and date already live on the
 * invoice (total_usd, issued_at); the receiving account is the payment method.
 *
 * All nullable and additive: existing invoices keep working; capturing these
 * is optional at cobro time.
 */

exports.up = (pgm) => {
  pgm.addColumns('invoices', {
    payment_method_id: {
      type: 'integer',
      references: 'payment_methods',
      onDelete: 'SET NULL',
    },
    payment_reference: { type: 'text' },
    payer_bank: { type: 'text' }, // banco emisor
    proof_url: { type: 'text' }, // Storage path to the receipt image/PDF
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('invoices', ['payment_method_id', 'payment_reference', 'payer_bank', 'proof_url']);
};
