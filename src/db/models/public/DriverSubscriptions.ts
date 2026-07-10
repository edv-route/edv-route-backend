import type { UsersId } from './Users.js';
import type { SubscriptionPlansId } from './SubscriptionPlans.js';
import type { default as SubscriptionStatus } from './SubscriptionStatus.js';

/** Identifier type for public.driver_subscriptions */
export type DriverSubscriptionsId = string & { __brand: 'public.driver_subscriptions' };

/** Represents the table public.driver_subscriptions */
export default interface DriverSubscriptions {
  id: DriverSubscriptionsId;

  driver_id: UsersId;

  plan_id: SubscriptionPlansId;

  status: SubscriptionStatus;

  started_at: Date | null;

  current_period_start: Date | null;

  current_period_end: Date | null;

  cancelled_at: Date | null;

  created_at: Date;

  updated_at: Date;
}

/** Represents the initializer for the table public.driver_subscriptions */
export interface DriverSubscriptionsInitializer {
  /** Default value: gen_random_uuid() */
  id?: DriverSubscriptionsId;

  driver_id: UsersId;

  plan_id: SubscriptionPlansId;

  /** Default value: 'pending_payment'::subscription_status */
  status?: SubscriptionStatus;

  started_at?: Date | null;

  current_period_start?: Date | null;

  current_period_end?: Date | null;

  cancelled_at?: Date | null;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;
}

/** Represents the mutator for the table public.driver_subscriptions */
export interface DriverSubscriptionsMutator {
  id?: DriverSubscriptionsId;

  driver_id?: UsersId;

  plan_id?: SubscriptionPlansId;

  status?: SubscriptionStatus;

  started_at?: Date | null;

  current_period_start?: Date | null;

  current_period_end?: Date | null;

  cancelled_at?: Date | null;

  created_at?: Date;

  updated_at?: Date;
}