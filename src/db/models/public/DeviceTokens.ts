import type { UsersId } from './Users.js';
import type { default as DevicePlatform } from './DevicePlatform.js';

/** Identifier type for public.device_tokens */
export type DeviceTokensId = string & { __brand: 'public.device_tokens' };

/** Represents the table public.device_tokens */
export default interface DeviceTokens {
  id: DeviceTokensId;

  user_id: UsersId;

  token: string;

  platform: DevicePlatform;

  last_seen_at: Date;

  revoked_at: Date | null;

  created_at: Date;
}

/** Represents the initializer for the table public.device_tokens */
export interface DeviceTokensInitializer {
  id?: DeviceTokensId;

  user_id: UsersId;

  token: string;

  platform: DevicePlatform;

  /** Default value: now() */
  last_seen_at?: Date;

  revoked_at?: Date | null;

  /** Default value: now() */
  created_at?: Date;
}

/** Represents the mutator for the table public.device_tokens */
export interface DeviceTokensMutator {
  id?: DeviceTokensId;

  user_id?: UsersId;

  token?: string;

  platform?: DevicePlatform;

  last_seen_at?: Date;

  revoked_at?: Date | null;

  created_at?: Date;
}