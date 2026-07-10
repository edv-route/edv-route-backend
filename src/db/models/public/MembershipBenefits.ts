import type { MembershipsId } from './Memberships.js';
import type { BenefitsId } from './Benefits.js';

/** Represents the table public.membership_benefits */
export default interface MembershipBenefits {
  membership_id: MembershipsId;

  benefit_id: BenefitsId;
}

/** Represents the initializer for the table public.membership_benefits */
export interface MembershipBenefitsInitializer {
  membership_id: MembershipsId;

  benefit_id: BenefitsId;
}

/** Represents the mutator for the table public.membership_benefits */
export interface MembershipBenefitsMutator {
  membership_id?: MembershipsId;

  benefit_id?: BenefitsId;
}