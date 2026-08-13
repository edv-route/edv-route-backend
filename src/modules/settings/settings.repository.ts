import type pg from 'pg';
import type AppSettings from '../../db/models/public/AppSettings.js';
import type { Camelize } from '../../db/case-types.js';

/** Derived from the generated DB row model. */
export type SettingRecord = Camelize<AppSettings>;

const COLUMNS = `key, value, description, updated_by AS "updatedBy", updated_at AS "updatedAt"`;

/**
 * Settings whose value MUST be stored as a real JSON boolean. Their consumers
 * (the debt/subscription engines) compare with strict `=== true`, so a value
 * persisted as the string "true" would read as false and silently disable the
 * engine. Coerced at the write boundary so no client can break it with text.
 */
const BOOLEAN_SETTING_KEYS = new Set(['debt_engine_enabled']);

export class SettingsRepository {
  constructor(private readonly db: pg.Pool) {}

  async list(): Promise<SettingRecord[]> {
    const { rows } = await this.db.query<SettingRecord>(
      `SELECT ${COLUMNS} FROM app_settings ORDER BY key`,
    );
    return rows;
  }

  /** Single-key read with fallback for consumers of business settings. */
  async get(key: string, fallback: unknown): Promise<unknown> {
    const { rows } = await this.db.query<{ value: unknown }>(
      'SELECT value FROM app_settings WHERE key = $1',
      [key],
    );
    return rows[0]?.value ?? fallback;
  }

  /** Updates an existing key only - settings are born in migrations, never via API. */
  async update(key: string, value: unknown, updatedBy: string): Promise<SettingRecord | null> {
    // Boolean-typed settings are coerced so a stringified "true"/"false" can never
    // reach the jsonb column and defeat the engines' strict `=== true` checks.
    const normalized = BOOLEAN_SETTING_KEYS.has(key) ? value === true || value === 'true' : value;
    const { rows } = await this.db.query<SettingRecord>(
      `UPDATE app_settings SET value = $2, updated_by = $3 WHERE key = $1
       RETURNING ${COLUMNS}`,
      [key, JSON.stringify(normalized), updatedBy],
    );
    return rows[0] ?? null;
  }
}
