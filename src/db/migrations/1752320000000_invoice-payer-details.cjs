/* eslint-disable camelcase */

/**
 * Payer details captured at cobro time (2026-07-31), stamped on the invoice
 * alongside the method/reference/bank of Pieza 2:
 *  - paid_on:     the date the payer actually paid (may differ from issued_at,
 *                 which is when WE recorded it). A plain `date`, no time.
 *  - payer_phone: the phone the payment was made FROM — Pago Móvil only.
 *  - payer_id:    the national id of whoever paid — Pago Móvil only.
 *
 * All nullable and additive: existing invoices keep working; these are only
 * captured for the methods that need them, so they stay NULL elsewhere. The
 * invoice is a money document, so this only ADDS columns (never rewrites).
 */

exports.up = (pgm) => {
  pgm.addColumns('invoices', {
    paid_on: { type: 'date' },
    payer_phone: { type: 'text' },
    payer_id: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('invoices', ['paid_on', 'payer_phone', 'payer_id']);
};
