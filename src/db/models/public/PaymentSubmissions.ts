import type { UsersId } from './Users.js';
import type { default as PaymentSubmissionStatus } from './PaymentSubmissionStatus.js';
import type { PaymentMethodsId } from './PaymentMethods.js';
import type { default as DriverSource } from './DriverSource.js';
import type { AdminsId } from './Admins.js';
import type { InvoicesId } from './Invoices.js';

/** Identifier type for public.payment_submissions */
export type PaymentSubmissionsId = string & { __brand: 'public.payment_submissions' };

/** Represents the table public.payment_submissions */
export default interface PaymentSubmissions {
  id: PaymentSubmissionsId;

  driver_id: UsersId;

  status: PaymentSubmissionStatus;

  amount_usd: string;

  payment_method_id: PaymentMethodsId | null;

  payment_reference: string | null;

  payer_bank: string | null;

  paid_on: Date | null;

  payer_phone: string | null;

  payer_id: string | null;

  payer_account: string | null;

  note: string | null;

  source: DriverSource;

  submitted_by: AdminsId | null;

  reviewed_by: AdminsId | null;

  reviewed_at: Date | null;

  rejection_reason: string | null;

  invoice_id: InvoicesId | null;

  created_at: Date;

  updated_at: Date;

  purpose: string;

  context: unknown;
}

/** Represents the initializer for the table public.payment_submissions */
export interface PaymentSubmissionsInitializer {
  /** Default value: gen_random_uuid() */
  id?: PaymentSubmissionsId;

  driver_id: UsersId;

  /** Default value: 'pending'::payment_submission_status */
  status?: PaymentSubmissionStatus;

  amount_usd: string;

  payment_method_id?: PaymentMethodsId | null;

  payment_reference?: string | null;

  payer_bank?: string | null;

  paid_on?: Date | null;

  payer_phone?: string | null;

  payer_id?: string | null;

  payer_account?: string | null;

  note?: string | null;

  /** Default value: 'admin'::driver_source */
  source?: DriverSource;

  submitted_by?: AdminsId | null;

  reviewed_by?: AdminsId | null;

  reviewed_at?: Date | null;

  rejection_reason?: string | null;

  invoice_id?: InvoicesId | null;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;

  /** Default value: 'debt'::text */
  purpose?: string;

  /** Default value: '{}'::jsonb */
  context?: unknown;
}

/** Represents the mutator for the table public.payment_submissions */
export interface PaymentSubmissionsMutator {
  id?: PaymentSubmissionsId;

  driver_id?: UsersId;

  status?: PaymentSubmissionStatus;

  amount_usd?: string;

  payment_method_id?: PaymentMethodsId | null;

  payment_reference?: string | null;

  payer_bank?: string | null;

  paid_on?: Date | null;

  payer_phone?: string | null;

  payer_id?: string | null;

  payer_account?: string | null;

  note?: string | null;

  source?: DriverSource;

  submitted_by?: AdminsId | null;

  reviewed_by?: AdminsId | null;

  reviewed_at?: Date | null;

  rejection_reason?: string | null;

  invoice_id?: InvoicesId | null;

  created_at?: Date;

  updated_at?: Date;

  purpose?: string;

  context?: unknown;
}