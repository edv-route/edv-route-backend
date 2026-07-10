import type { default as RequirementAppliesTo } from './RequirementAppliesTo.js';
import type { AdminsId } from './Admins.js';

/** Identifier type for public.requirements */
export type RequirementsId = number & { __brand: 'public.requirements' };

/** Represents the table public.requirements */
export default interface Requirements {
  id: RequirementsId;

  name: string;

  description: string | null;

  applies_to: RequirementAppliesTo;

  is_required: boolean;

  active: boolean;

  created_by: AdminsId | null;

  created_at: Date;

  updated_at: Date;
}

/** Represents the initializer for the table public.requirements */
export interface RequirementsInitializer {
  id?: RequirementsId;

  name: string;

  description?: string | null;

  applies_to: RequirementAppliesTo;

  /** Default value: false */
  is_required?: boolean;

  /** Default value: true */
  active?: boolean;

  created_by?: AdminsId | null;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;
}

/** Represents the mutator for the table public.requirements */
export interface RequirementsMutator {
  id?: RequirementsId;

  name?: string;

  description?: string | null;

  applies_to?: RequirementAppliesTo;

  is_required?: boolean;

  active?: boolean;

  created_by?: AdminsId | null;

  created_at?: Date;

  updated_at?: Date;
}