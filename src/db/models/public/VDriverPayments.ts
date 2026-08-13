import type { SubscriptionPaymentsId } from './SubscriptionPayments.js';
import type { UsersId } from './Users.js';
import type { AdminsId } from './Admins.js';
import type { InvoicesId } from './Invoices.js';

/** Represents the view public.v_driver_payments */
export default interface VDriverPayments {
  id: SubscriptionPaymentsId;

  driver_id: UsersId;

  kind: string;

  concept: string;

  amount_usd: string;

  status: string;

  paid_at: Date | null;

  refunded_at: Date | null;

  refunded_by: AdminsId | null;

  period_start: Date | null;

  period_end: Date | null;

  invoice_id: InvoicesId | null;

  created_at: Date;
}