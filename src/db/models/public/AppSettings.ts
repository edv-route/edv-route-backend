import type { AdminsId } from './Admins.js';

/** Identifier type for public.app_settings */
export type AppSettingsKey = string & { __brand: 'public.app_settings' };

/** Represents the table public.app_settings */
export default interface AppSettings {
  key: AppSettingsKey;

  value: unknown;

  description: string | null;

  updated_by: AdminsId | null;

  updated_at: Date;
}

/** Represents the initializer for the table public.app_settings */
export interface AppSettingsInitializer {
  key: AppSettingsKey;

  value: unknown;

  description?: string | null;

  updated_by?: AdminsId | null;

  /** Default value: now() */
  updated_at?: Date;
}

/** Represents the mutator for the table public.app_settings */
export interface AppSettingsMutator {
  key?: AppSettingsKey;

  value?: unknown;

  description?: string | null;

  updated_by?: AdminsId | null;

  updated_at?: Date;
}