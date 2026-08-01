/* eslint-disable camelcase */

/**
 * Payer account identifier (2026-07-31): the email or name the payment came
 * FROM — needed for Zelle/Binance to reconcile the receipt (Pago Móvil already
 * has payer_phone/payer_id for this). Nullable and additive; only captured for
 * the methods that need it.
 */

exports.up = (pgm) => {
  pgm.addColumns('invoices', {
    payer_account: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('invoices', ['payer_account']);
};
