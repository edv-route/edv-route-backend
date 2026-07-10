import type { default as BillingPeriod } from './BillingPeriod.js';
import type { AdminsId } from './Admins.js';

/** Identifier type for public.subscription_plans */
export type SubscriptionPlansId = number & { __brand: 'public.subscription_plans' };

/** Represents the table public.subscription_plans */
export default interface SubscriptionPlans {
  id: SubscriptionPlansId;

  name: string;

  description: string | null;

  billing_period: BillingPeriod;

  price_usd: string;

  allowed_vehicle_types: number[] | null;

  active: boolean;

  created_by: AdminsId | null;

  created_at: Date;

  updated_at: Date;
}

/** Represents the initializer for the table public.subscription_plans */
export interface SubscriptionPlansInitializer {
  id?: SubscriptionPlansId;

  name: string;

  description?: string | null;

  billing_period: BillingPeriod;

  price_usd: string;

  allowed_vehicle_types?: number[] | null;

  /** Default value: true */
  active?: boolean;

  created_by?: AdminsId | null;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;
}

/** Represents the mutator for the table public.subscription_plans */
export interface SubscriptionPlansMutator {
  id?: SubscriptionPlansId;

  name?: string;

  description?: string | null;

  billing_period?: BillingPeriod;

  price_usd?: string;

  allowed_vehicle_types?: number[] | null;

  active?: boolean;

  created_by?: AdminsId | null;

  created_at?: Date;

  updated_at?: Date;
}