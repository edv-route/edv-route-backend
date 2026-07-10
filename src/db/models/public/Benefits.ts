/** Identifier type for public.benefits */
export type BenefitsId = number & { __brand: 'public.benefits' };

/** Represents the table public.benefits */
export default interface Benefits {
  id: BenefitsId;

  name: string;

  description: string | null;

  active: boolean;

  created_at: Date;

  updated_at: Date;
}

/** Represents the initializer for the table public.benefits */
export interface BenefitsInitializer {
  id?: BenefitsId;

  name: string;

  description?: string | null;

  /** Default value: true */
  active?: boolean;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;
}

/** Represents the mutator for the table public.benefits */
export interface BenefitsMutator {
  id?: BenefitsId;

  name?: string;

  description?: string | null;

  active?: boolean;

  created_at?: Date;

  updated_at?: Date;
}