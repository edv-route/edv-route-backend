import type { AdminsId } from './Admins.js';

/** Identifier type for public.memberships */
export type MembershipsId = number & { __brand: 'public.memberships' };

/** Represents the table public.memberships */
export default interface Memberships {
  id: MembershipsId;

  name: string;

  description: string | null;

  price_usd: string;

  active: boolean;

  created_by: AdminsId | null;

  created_at: Date;

  updated_at: Date;
}

/** Represents the initializer for the table public.memberships */
export interface MembershipsInitializer {
  id?: MembershipsId;

  name: string;

  description?: string | null;

  price_usd: string;

  /** Default value: true */
  active?: boolean;

  created_by?: AdminsId | null;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;
}

/** Represents the mutator for the table public.memberships */
export interface MembershipsMutator {
  id?: MembershipsId;

  name?: string;

  description?: string | null;

  price_usd?: string;

  active?: boolean;

  created_by?: AdminsId | null;

  created_at?: Date;

  updated_at?: Date;
}