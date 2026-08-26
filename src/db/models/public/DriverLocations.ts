import type { UsersId } from './Users.js';

/** Identifier type for public.driver_locations */
export type DriverLocationsId = string & { __brand: 'public.driver_locations' };

/** Represents the table public.driver_locations */
export default interface DriverLocations {
  id: DriverLocationsId;

  driver_id: UsersId;

  point: unknown;

  accuracy_m: number | null;

  recorded_at: Date;

  created_at: Date;
}

/** Represents the initializer for the table public.driver_locations */
export interface DriverLocationsInitializer {
  id?: DriverLocationsId;

  driver_id: UsersId;

  point: unknown;

  accuracy_m?: number | null;

  recorded_at: Date;

  /** Default value: now() */
  created_at?: Date;
}

/** Represents the mutator for the table public.driver_locations */
export interface DriverLocationsMutator {
  id?: DriverLocationsId;

  driver_id?: UsersId;

  point?: unknown;

  accuracy_m?: number | null;

  recorded_at?: Date;

  created_at?: Date;
}