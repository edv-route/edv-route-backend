import type { UsersId } from './Users.js';
import type { default as InvoiceStatus } from './InvoiceStatus.js';
import type { AdminsId } from './Admins.js';
import type { PaymentMethodsId } from './PaymentMethods.js';

/** Identifier type for public.invoices */
export type InvoicesId = string & { __brand: 'public.invoices' };

/** Represents the table public.invoices */
export default interface Invoices {
  id: InvoicesId;

  invoice_number: string;

  driver_id: UsersId;

  issued_at: Date;

  total_usd: string;

  status: InvoiceStatus;

  voided_at: Date | null;

  voided_by: AdminsId | null;

  registered_by: AdminsId | null;

  created_at: Date;

  payment_method_id: PaymentMethodsId | null;

  payment_reference: string | null;

  payer_bank: string | null;

  proof_url: string | null;
}

/** Represents the initializer for the table public.invoices */
export interface InvoicesInitializer {
  /** Default value: gen_random_uuid() */
  id?: InvoicesId;

  /** Default value: nextval('invoice_number_seq'::regclass) */
  invoice_number?: string;

  driver_id: UsersId;

  /** Default value: now() */
  issued_at?: Date;

  total_usd: string;

  /** Default value: 'issued'::invoice_status */
  status?: InvoiceStatus;

  voided_at?: Date | null;

  voided_by?: AdminsId | null;

  registered_by?: AdminsId | null;

  /** Default value: now() */
  created_at?: Date;

  payment_method_id?: PaymentMethodsId | null;

  payment_reference?: string | null;

  payer_bank?: string | null;

  proof_url?: string | null;
}

/** Represents the mutator for the table public.invoices */
export interface InvoicesMutator {
  id?: InvoicesId;

  invoice_number?: string;

  driver_id?: UsersId;

  issued_at?: Date;

  total_usd?: string;

  status?: InvoiceStatus;

  voided_at?: Date | null;

  voided_by?: AdminsId | null;

  registered_by?: AdminsId | null;

  created_at?: Date;

  payment_method_id?: PaymentMethodsId | null;

  payment_reference?: string | null;

  payer_bank?: string | null;

  proof_url?: string | null;
}