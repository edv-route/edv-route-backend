import type { UsersId } from './Users.js';
import type { MembershipsId } from './Memberships.js';
import type { InvoicesId } from './Invoices.js';
import type { default as MembershipPaymentStatus } from './MembershipPaymentStatus.js';
import type { AdminsId } from './Admins.js';
import type { PaymentSubmissionsId } from './PaymentSubmissions.js';

/** Identifier type for public.membership_payments */
export type MembershipPaymentsId = string & { __brand: 'public.membership_payments' };

/** Represents the table public.membership_payments */
export default interface MembershipPayments {
  id: MembershipPaymentsId;

  driver_id: UsersId;

  membership_id: MembershipsId;

  invoice_id: InvoicesId | null;

  amount_usd: string;

  status: MembershipPaymentStatus;

  paid_at: Date | null;

  refunded_at: Date | null;

  refunded_by: AdminsId | null;

  registered_by: AdminsId | null;

  created_at: Date;

  submission_id: PaymentSubmissionsId | null;
}

/** Represents the initializer for the table public.membership_payments */
export interface MembershipPaymentsInitializer {
  /** Default value: gen_random_uuid() */
  id?: MembershipPaymentsId;

  driver_id: UsersId;

  membership_id: MembershipsId;

  invoice_id?: InvoicesId | null;

  amount_usd: string;

  /** Default value: 'pending'::membership_payment_status */
  status?: MembershipPaymentStatus;

  paid_at?: Date | null;

  refunded_at?: Date | null;

  refunded_by?: AdminsId | null;

  registered_by?: AdminsId | null;

  /** Default value: now() */
  created_at?: Date;

  submission_id?: PaymentSubmissionsId | null;
}

/** Represents the mutator for the table public.membership_payments */
export interface MembershipPaymentsMutator {
  id?: MembershipPaymentsId;

  driver_id?: UsersId;

  membership_id?: MembershipsId;

  invoice_id?: InvoicesId | null;

  amount_usd?: string;

  status?: MembershipPaymentStatus;

  paid_at?: Date | null;

  refunded_at?: Date | null;

  refunded_by?: AdminsId | null;

  registered_by?: AdminsId | null;

  created_at?: Date;

  submission_id?: PaymentSubmissionsId | null;
}