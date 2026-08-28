import type { SettingsRepository } from '../settings/settings.repository.js';

/** Fallbacks if the settings row ever goes missing. Same values as the migration. */
export const DEFAULT_INTERVAL_SECONDS = 600;
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * Seconds between reports while idle. Read from settings on EVERY call, never
 * cached: raising the pace from the panel has to reach the phones (and the
 * panel's own idea of who is "online") without a redeploy.
 */
export async function readIntervalSeconds(settings: SettingsRepository): Promise<number> {
  const raw = await settings.get('location_interval_seconds', DEFAULT_INTERVAL_SECONDS);
  const value = Number(raw);
  // A nonsense value in the settings table must not turn into a phone
  // hammering the API every second, nor into one that never reports again.
  return Number.isFinite(value) && value >= 30 && value <= 3600
    ? Math.floor(value)
    : DEFAULT_INTERVAL_SECONDS;
}

/** Days of history kept. Read by the purge job and by the map's staleness cut-off. */
export async function readRetentionDays(settings: SettingsRepository): Promise<number> {
  const raw = await settings.get('location_retention_days', DEFAULT_RETENTION_DAYS);
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 && value <= 365
    ? Math.floor(value)
    : DEFAULT_RETENTION_DAYS;
}
