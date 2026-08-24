import type { UsersId } from './Users.js';

/** Identifier type for public.password_reset_codes */
export type PasswordResetCodesId = string & { __brand: 'public.password_reset_codes' };

/** Represents the table public.password_reset_codes */
export default interface PasswordResetCodes {
  id: PasswordResetCodesId;

  user_id: UsersId;

  code_hash: string;

  expires_at: Date;

  attempts: number;

  verified_at: Date | null;

  used_at: Date | null;

  requested_ip: string | null;

  created_at: Date;
}

/** Represents the initializer for the table public.password_reset_codes */
export interface PasswordResetCodesInitializer {
  id?: PasswordResetCodesId;

  user_id: UsersId;

  code_hash: string;

  expires_at: Date;

  /** Default value: 0 */
  attempts?: number;

  verified_at?: Date | null;

  used_at?: Date | null;

  requested_ip?: string | null;

  /** Default value: now() */
  created_at?: Date;
}

/** Represents the mutator for the table public.password_reset_codes */
export interface PasswordResetCodesMutator {
  id?: PasswordResetCodesId;

  user_id?: UsersId;

  code_hash?: string;

  expires_at?: Date;

  attempts?: number;

  verified_at?: Date | null;

  used_at?: Date | null;

  requested_ip?: string | null;

  created_at?: Date;
}