import type { PaymentSubmissionsId } from './PaymentSubmissions.js';
import type { InvoicesId } from './Invoices.js';
import type { default as PaymentSubmissionStatus } from './PaymentSubmissionStatus.js';

/** Represents the table public.payment_submission_invoices */
export default interface PaymentSubmissionInvoices {
  submission_id: PaymentSubmissionsId;

  invoice_id: InvoicesId;

  submission_status: PaymentSubmissionStatus;

  created_at: Date;
}

/** Represents the initializer for the table public.payment_submission_invoices */
export interface PaymentSubmissionInvoicesInitializer {
  submission_id: PaymentSubmissionsId;

  invoice_id: InvoicesId;

  submission_status: PaymentSubmissionStatus;

  /** Default value: now() */
  created_at?: Date;
}

/** Represents the mutator for the table public.payment_submission_invoices */
export interface PaymentSubmissionInvoicesMutator {
  submission_id?: PaymentSubmissionsId;

  invoice_id?: InvoicesId;

  submission_status?: PaymentSubmissionStatus;

  created_at?: Date;
}