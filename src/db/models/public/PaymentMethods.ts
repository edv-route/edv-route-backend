import type { default as PaymentMethodType } from './PaymentMethodType.js';
import type { AdminsId } from './Admins.js';

/** Identifier type for public.payment_methods */
export type PaymentMethodsId = number & { __brand: 'public.payment_methods' };

/** Represents the table public.payment_methods */
export default interface PaymentMethods {
  id: PaymentMethodsId;

  name: string;

  type: PaymentMethodType;

  details: unknown;

  is_active: boolean;

  created_by: AdminsId | null;

  created_at: Date;

  updated_at: Date;
}

/** Represents the initializer for the table public.payment_methods */
export interface PaymentMethodsInitializer {
  id?: PaymentMethodsId;

  name: string;

  type: PaymentMethodType;

  /** Default value: '{}'::jsonb */
  details?: unknown;

  /** Default value: true */
  is_active?: boolean;

  created_by?: AdminsId | null;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;
}

/** Represents the mutator for the table public.payment_methods */
export interface PaymentMethodsMutator {
  id?: PaymentMethodsId;

  name?: string;

  type?: PaymentMethodType;

  details?: unknown;

  is_active?: boolean;

  created_by?: AdminsId | null;

  created_at?: Date;

  updated_at?: Date;
}