/** Represents the enum public.subscription_status */
type SubscriptionStatus = 
  | 'pending_payment'
  | 'active'
  | 'scheduled'
  | 'expired'
  | 'cancelled';

export type { SubscriptionStatus as default };