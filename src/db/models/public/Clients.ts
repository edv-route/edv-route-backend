import type { UsersId } from './Users.js';

/** Represents the table public.clients */
export default interface Clients {
  user_id: UsersId;

  status: string;

  accepted_privacy_at: Date | null;

  created_at: Date;

  updated_at: Date;
}

/** Represents the initializer for the table public.clients */
export interface ClientsInitializer {
  user_id: UsersId;

  /** Default value: 'active'::text */
  status?: string;

  accepted_privacy_at?: Date | null;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;
}

/** Represents the mutator for the table public.clients */
export interface ClientsMutator {
  user_id?: UsersId;

  status?: string;

  accepted_privacy_at?: Date | null;

  created_at?: Date;

  updated_at?: Date;
}