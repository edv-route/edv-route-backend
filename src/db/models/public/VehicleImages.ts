import type { VehiclesId } from './Vehicles.js';
import type { AdminsId } from './Admins.js';

/** Identifier type for public.vehicle_images */
export type VehicleImagesId = string & { __brand: 'public.vehicle_images' };

/** Represents the table public.vehicle_images */
export default interface VehicleImages {
  id: VehicleImagesId;

  vehicle_id: VehiclesId;

  file_url: string;

  position: number;

  uploaded_by: AdminsId | null;

  created_at: Date;
}

/** Represents the initializer for the table public.vehicle_images */
export interface VehicleImagesInitializer {
  /** Default value: gen_random_uuid() */
  id?: VehicleImagesId;

  vehicle_id: VehiclesId;

  file_url: string;

  position: number;

  uploaded_by?: AdminsId | null;

  /** Default value: now() */
  created_at?: Date;
}

/** Represents the mutator for the table public.vehicle_images */
export interface VehicleImagesMutator {
  id?: VehicleImagesId;

  vehicle_id?: VehiclesId;

  file_url?: string;

  position?: number;

  uploaded_by?: AdminsId | null;

  created_at?: Date;
}