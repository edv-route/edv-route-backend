/* eslint-disable camelcase */

/**
 * Payment methods catalog (Pieza 1): the accounts where drivers pay their
 * membership and tariff. Informative registry (not a gateway): the admin
 * registers the accounts, the driver pays outside the system and later a
 * receipt is attached (Pieza 2).
 *
 * `details` is a jsonb whose shape depends on `type` (bank fields, wallet
 * address, email, phone…). Postgres jsonb keeps the per-type flexibility
 * without rigid columns; the shape is validated per type in the service layer.
 */

exports.up = (pgm) => {
  pgm.createType('payment_method_type', [
    'bank_transfer', // transferencia bancaria nacional
    'pago_movil', // Pago Móvil (Venezuela)
    'zelle',
    'paypal',
    'binance', // Binance Pay
    'crypto', // USDT - Wallet TRC20
    'contact', // contactar al administrador
  ]);

  pgm.createTable('payment_methods', {
    id: {
      type: 'integer',
      primaryKey: true,
      sequenceGenerated: { precedence: 'BY DEFAULT' },
    },
    name: { type: 'text', notNull: true }, // free label, e.g. "Banesco - Ahorro"
    type: { type: 'payment_method_type', notNull: true },
    details: { type: 'jsonb', notNull: true, default: '{}' },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_by: { type: 'uuid', references: 'admins', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTrigger('payment_methods', 'trg_payment_methods_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('payment_methods');
  pgm.dropType('payment_method_type');
};
