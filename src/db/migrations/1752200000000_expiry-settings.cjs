/* eslint-disable camelcase */

/**
 * Block 4 - expiry & renewal settings (business decisions 2026-07-10):
 *  - Periods expire at 00:00 (business timezone) of the corresponding day;
 *    rolling windows are kept (no calendar anchoring).
 *  - Immediate suspension on expiry: grace goes to 0 (key stays configurable).
 *  - payment_reminder_days: "due soon" badge threshold (panel now, driver app later).
 */

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO app_settings (key, value, description) VALUES
    ('payment_reminder_days', '3',
     'Días antes del vencimiento de la tarifa a partir de los cuales se muestra la alerta de pago próximo'),
    ('business_timezone', '"America/Caracas"',
     'Zona horaria del negocio: los períodos vencen a las 00:00 de esta zona')
  `);

  pgm.sql(`
    UPDATE app_settings SET
      value = '0',
      description = 'Horas de gracia tras vencer la tarifa antes de suspender la operación (0 = suspensión inmediata, decisión 2026-07-10)'
    WHERE key = 'subscription_grace_hours'
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM app_settings WHERE key IN ('payment_reminder_days', 'business_timezone')`);
  pgm.sql(`UPDATE app_settings SET value = '24' WHERE key = 'subscription_grace_hours'`);
};
