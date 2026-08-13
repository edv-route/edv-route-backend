import type { UsersId } from './Users.js';
import type { VehicleTypesId } from './VehicleTypes.js';
import type { default as VehicleApproval } from './VehicleApproval.js';
import type { AdminsId } from './Admins.js';

/** Identifier type for public.vehicles */
export type VehiclesId = string & { __brand: 'public.vehicles' };

/** Represents the table public.vehicles */
export default interface Vehicles {
  id: VehiclesId;

  driver_id: UsersId;

  vehicle_type_id: VehicleTypesId | null;

  brand: string | null;

  model: string | null;

  year: number | null;

  color: string | null;

  plate: string | null;

  approval_status: VehicleApproval;

  registered_by: AdminsId | null;

  created_at: Date;

  updated_at: Date;

  rejection_reason: string | null;
}

/** Represents the initializer for the table public.vehicles */
export interface VehiclesInitializer {
  /** Default value: gen_random_uuid() */
  id?: VehiclesId;

  driver_id: UsersId;

  vehicle_type_id?: VehicleTypesId | null;

  brand?: string | null;

  model?: string | null;

  year?: number | null;

  color?: string | null;

  plate?: string | null;

  /** Default value: 'pending'::vehicle_approval */
  approval_status?: VehicleApproval;

  registered_by?: AdminsId | null;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;

  rejection_reason?: string | null;
}

/** Represents the mutator for the table public.vehicles */
export interface VehiclesMutator {
  id?: VehiclesId;

  driver_id?: UsersId;

  vehicle_type_id?: VehicleTypesId | null;

  brand?: string | null;

  model?: string | null;

  year?: number | null;

  color?: string | null;

  plate?: string | null;

  approval_status?: VehicleApproval;

  registered_by?: AdminsId | null;

  created_at?: Date;

  updated_at?: Date;

  rejection_reason?: string | null;
}