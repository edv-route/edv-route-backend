/* eslint-disable camelcase */

/**
 * Fase B (diseño v8) - B1: additive-only groundwork for the debt/penalty engine.
 * (spec: docs/proposals/tarifa-penalizacion/analisis-impacto-v8.md)
 *
 * Adds the `driver_status` values `overdue`/`penalized` - already part of the
 * CLOSED driver-state model (docs/proposals/estados-del-chofer) - and the
 * engine's configurable parameters as `app_settings` keys.
 *
 * Changes NO billing behaviour: nothing reads these yet. The engine that emits
 * weekly charges, marks arrears and derives the state (B2) is a separate,
 * later step that will touch the cobro in production. Values are the confirmed
 * defaults; all editable from Configuración. Descriptions flag them as "en
 * preparación" so an admin does not expect an effect before B2 ships.
 *
 * PG15 (Supabase) allows ALTER TYPE ... ADD VALUE inside a transaction as long
 * as the new value is not USED in the same transaction - it isn't here (the
 * INSERT below writes app_settings, not drivers.status).
 */

exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE driver_status ADD VALUE IF NOT EXISTS 'overdue'`);
  pgm.sql(`ALTER TYPE driver_status ADD VALUE IF NOT EXISTS 'penalized'`);

  pgm.sql(`
    INSERT INTO app_settings (key, value, description) VALUES
    ('debt_cap_weeks', '2',
     'Motor de deuda (v8, en preparación — sin efecto hasta B2): semanas de tarifa que un chofer puede deber y seguir operando antes de penalizarse'),
    ('penalty_weeks', '1',
     'Motor de deuda (v8, en preparación — sin efecto hasta B2): semanas de penalización (multa) al superar el tope de deuda'),
    ('billing_day_of_week', '5',
     'Motor de deuda (v8, en preparación — sin efecto hasta B2): día de emisión del cobro semanal (ISO 1=lunes … 7=domingo; 5=viernes)'),
    ('billing_hour', '18',
     'Motor de deuda (v8, en preparación — sin efecto hasta B2): hora de emisión del cobro semanal en la zona del negocio (0-23; 18 = 6pm)'),
    ('week_anchor_day', '1',
     'Motor de deuda (v8, en preparación — sin efecto hasta B2): día en que arranca la semana de tarifa (ISO 1 = lunes)'),
    ('reactivation_mode', '"auto"',
     'Motor de deuda (v8, en preparación — sin efecto hasta B2): reactivación por defecto tras pagar (auto = el lunes siguiente; el admin siempre puede reactivar manualmente de inmediato)')
    ON CONFLICT (key) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM app_settings WHERE key IN (
    'debt_cap_weeks', 'penalty_weeks', 'billing_day_of_week', 'billing_hour',
    'week_anchor_day', 'reactivation_mode'
  )`);
  // NOTE: PostgreSQL cannot DROP a value from an enum, so overdue/penalized
  // remain in driver_status. Harmless: nothing sets them until B2.
};
