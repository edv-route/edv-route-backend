import type { DriverSubscriptionsId } from './DriverSubscriptions.js';
import type { InvoicesId } from './Invoices.js';
import type { default as SubscriptionPaymentStatus } from './SubscriptionPaymentStatus.js';
import type { AdminsId } from './Admins.js';
import type { default as SubscriptionChargeKind } from './SubscriptionChargeKind.js';
import type { PaymentSubmissionsId } from './PaymentSubmissions.js';

/** Identifier type for public.subscription_payments */
export type SubscriptionPaymentsId = string & { __brand: 'public.subscription_payments' };

/** Represents the table public.subscription_payments */
export default interface SubscriptionPayments {
  id: SubscriptionPaymentsId;

  driver_subscription_id: DriverSubscriptionsId;

  invoice_id: InvoicesId | null;

  period_start: Date | null;

  period_end: Date | null;

  amount_usd: string;

  status: SubscriptionPaymentStatus;

  paid_at: Date | null;

  refunded_at: Date | null;

  refunded_by: AdminsId | null;

  registered_by: AdminsId | null;

  created_at: Date;

  charge_kind: SubscriptionChargeKind;

  submission_id: PaymentSubmissionsId | null;
}

/** Represents the initializer for the table public.subscription_payments */
export interface SubscriptionPaymentsInitializer {
  /** Default value: gen_random_uuid() */
  id?: SubscriptionPaymentsId;

  driver_subscription_id: DriverSubscriptionsId;

  invoice_id?: InvoicesId | null;

  period_start?: Date | null;

  period_end?: Date | null;

  amount_usd: string;

  /** Default value: 'pending'::subscription_payment_status */
  status?: SubscriptionPaymentStatus;

  paid_at?: Date | null;

  refunded_at?: Date | null;

  refunded_by?: AdminsId | null;

  registered_by?: AdminsId | null;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: 'period'::subscription_charge_kind */
  charge_kind?: SubscriptionChargeKind;

  submission_id?: PaymentSubmissionsId | null;
}

/** Represents the mutator for the table public.subscription_payments */
export interface SubscriptionPaymentsMutator {
  id?: SubscriptionPaymentsId;

  driver_subscription_id?: DriverSubscriptionsId;

  invoice_id?: InvoicesId | null;

  period_start?: Date | null;

  period_end?: Date | null;

  amount_usd?: string;

  status?: SubscriptionPaymentStatus;

  paid_at?: Date | null;

  refunded_at?: Date | null;

  refunded_by?: AdminsId | null;

  registered_by?: AdminsId | null;

  created_at?: Date;

  charge_kind?: SubscriptionChargeKind;

  submission_id?: PaymentSubmissionsId | null;
}