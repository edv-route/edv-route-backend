import type { default as AdminStatus } from './AdminStatus.js';

/** Identifier type for public.admins */
export type AdminsId = string & { __brand: 'public.admins' };

/** Represents the table public.admins */
export default interface Admins {
  id: AdminsId;

  username: string;

  email: string | null;

  full_name: string;

  password_hash: string;

  role: string;

  status: AdminStatus;

  failed_login_attempts: number;

  locked_until: Date | null;

  last_login_at: Date | null;

  created_by: AdminsId | null;

  created_at: Date;

  updated_at: Date;
}

/** Represents the initializer for the table public.admins */
export interface AdminsInitializer {
  /** Default value: gen_random_uuid() */
  id?: AdminsId;

  username: string;

  email?: string | null;

  full_name: string;

  password_hash: string;

  /** Default value: 'admin'::text */
  role?: string;

  /** Default value: 'active'::admin_status */
  status?: AdminStatus;

  /** Default value: 0 */
  failed_login_attempts?: number;

  locked_until?: Date | null;

  last_login_at?: Date | null;

  created_by?: AdminsId | null;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;
}

/** Represents the mutator for the table public.admins */
export interface AdminsMutator {
  id?: AdminsId;

  username?: string;

  email?: string | null;

  full_name?: string;

  password_hash?: string;

  role?: string;

  status?: AdminStatus;

  failed_login_attempts?: number;

  locked_until?: Date | null;

  last_login_at?: Date | null;

  created_by?: AdminsId | null;

  created_at?: Date;

  updated_at?: Date;
}