/** Identifier type for public.vehicle_types */
export type VehicleTypesId = number & { __brand: 'public.vehicle_types' };

/** Represents the table public.vehicle_types */
export default interface VehicleTypes {
  id: VehicleTypesId;

  name: string;

  active: boolean;

  created_at: Date;

  updated_at: Date;
}

/** Represents the initializer for the table public.vehicle_types */
export interface VehicleTypesInitializer {
  id?: VehicleTypesId;

  name: string;

  /** Default value: true */
  active?: boolean;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;
}

/** Represents the mutator for the table public.vehicle_types */
export interface VehicleTypesMutator {
  id?: VehicleTypesId;

  name?: string;

  active?: boolean;

  created_at?: Date;

  updated_at?: Date;
}