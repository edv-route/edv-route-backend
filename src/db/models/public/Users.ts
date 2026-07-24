import type { default as UserStatus } from './UserStatus.js';

/** Identifier type for public.users */
export type UsersId = string & { __brand: 'public.users' };

/** Represents the table public.users */
export default interface Users {
  id: UsersId;

  auth_user_id: string | null;

  full_name: string;

  email: string | null;

  phone: string | null;

  photo_url: string | null;

  status: UserStatus;

  created_at: Date;

  updated_at: Date;

  first_name: string;

  middle_name: string | null;

  last_name: string;

  second_last_name: string | null;

  birth_date: Date | null;

  address: string | null;

  password_hash: string | null;
}

/** Represents the initializer for the table public.users */
export interface UsersInitializer {
  /** Default value: gen_random_uuid() */
  id?: UsersId;

  auth_user_id?: string | null;

  full_name: string;

  email?: string | null;

  phone?: string | null;

  photo_url?: string | null;

  /** Default value: 'active'::user_status */
  status?: UserStatus;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;

  first_name: string;

  middle_name?: string | null;

  last_name: string;

  second_last_name?: string | null;

  birth_date?: Date | null;

  address?: string | null;

  password_hash?: string | null;
}

/** Represents the mutator for the table public.users */
export interface UsersMutator {
  id?: UsersId;

  auth_user_id?: string | null;

  full_name?: string;

  email?: string | null;

  phone?: string | null;

  photo_url?: string | null;

  status?: UserStatus;

  created_at?: Date;

  updated_at?: Date;

  first_name?: string;

  middle_name?: string | null;

  last_name?: string;

  second_last_name?: string | null;

  birth_date?: Date | null;

  address?: string | null;

  password_hash?: string | null;
}