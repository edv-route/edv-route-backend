import type { UsersId } from './Users.js';
import type { default as DriverStatus } from './DriverStatus.js';
import type { default as DriverSource } from './DriverSource.js';
import type { AdminsId } from './Admins.js';
import type { VehiclesId } from './Vehicles.js';

/** Represents the table public.drivers */
export default interface Drivers {
  user_id: UsersId;

  national_id: string | null;

  status: DriverStatus;

  source: DriverSource;

  registered_by: AdminsId | null;

  registration_step: number | null;

  current_vehicle_id: VehiclesId | null;

  is_available: boolean;

  avg_rating: string | null;

  rating_count: number;

  cancel_count: number;

  contract_url: string | null;

  created_at: Date;

  updated_at: Date;

  paused_at: Date | null;

  reactivates_at: Date | null;

  accepted_privacy_at: Date | null;

  accepted_terms_at: Date | null;

  tariff_start_set_at: Date | null;
}

/** Represents the initializer for the table public.drivers */
export interface DriversInitializer {
  user_id: UsersId;

  national_id?: string | null;

  /** Default value: 'pending'::driver_status */
  status?: DriverStatus;

  source: DriverSource;

  registered_by?: AdminsId | null;

  registration_step?: number | null;

  current_vehicle_id?: VehiclesId | null;

  /** Default value: true */
  is_available?: boolean;

  avg_rating?: string | null;

  /** Default value: 0 */
  rating_count?: number;

  /** Default value: 0 */
  cancel_count?: number;

  contract_url?: string | null;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;

  paused_at?: Date | null;

  reactivates_at?: Date | null;

  accepted_privacy_at?: Date | null;

  accepted_terms_at?: Date | null;

  tariff_start_set_at?: Date | null;
}

/** Represents the mutator for the table public.drivers */
export interface DriversMutator {
  user_id?: UsersId;

  national_id?: string | null;

  status?: DriverStatus;

  source?: DriverSource;

  registered_by?: AdminsId | null;

  registration_step?: number | null;

  current_vehicle_id?: VehiclesId | null;

  is_available?: boolean;

  avg_rating?: string | null;

  rating_count?: number;

  cancel_count?: number;

  contract_url?: string | null;

  created_at?: Date;

  updated_at?: Date;

  paused_at?: Date | null;

  reactivates_at?: Date | null;

  accepted_privacy_at?: Date | null;

  accepted_terms_at?: Date | null;

  tariff_start_set_at?: Date | null;
}