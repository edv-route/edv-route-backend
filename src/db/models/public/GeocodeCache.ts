/** Identifier type for public.geocode_cache */
export type GeocodeCacheGridKey = string & { __brand: 'public.geocode_cache' };

/** Represents the table public.geocode_cache */
export default interface GeocodeCache {
  grid_key: GeocodeCacheGridKey;

  lat: number;

  lon: number;

  label: string | null;

  created_at: Date;
}

/** Represents the initializer for the table public.geocode_cache */
export interface GeocodeCacheInitializer {
  grid_key: GeocodeCacheGridKey;

  lat: number;

  lon: number;

  label?: string | null;

  /** Default value: now() */
  created_at?: Date;
}

/** Represents the mutator for the table public.geocode_cache */
export interface GeocodeCacheMutator {
  grid_key?: GeocodeCacheGridKey;

  lat?: number;

  lon?: number;

  label?: string | null;

  created_at?: Date;
}