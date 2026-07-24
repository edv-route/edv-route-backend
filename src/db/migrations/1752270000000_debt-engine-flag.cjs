/* eslint-disable camelcase */

/**
 * Fase B (diseño v8) - B2: master switch for the debt/penalty engine.
 *
 * The engine (src/plugins/debt-scheduler.ts) reads this key on every tick and
 * does NOTHING while it is false. That keeps the weekly-charge/arrears logic
 * shippable and testable without altering the cobro in production: the prepaid
 * model (immediate expiry) keeps running exactly as before until the business
 * decides to flip it.
 */

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO app_settings (key, value, description) VALUES
    ('debt_engine_enabled', 'false',
     'Motor de deuda (v8): interruptor maestro. false = el cobro sigue con el modelo prepago actual (sin cambios); true = activa la emisión semanal del cobro, la mora y la penalización automática')
    ON CONFLICT (key) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM app_settings WHERE key = 'debt_engine_enabled'`);
};
