/** Identifier type for public.pgmigrations */
export type PgmigrationsId = number & { __brand: 'public.pgmigrations' };

/** Represents the table public.pgmigrations */
export default interface Pgmigrations {
  id: PgmigrationsId;

  name: string;

  run_on: Date;
}

/** Represents the initializer for the table public.pgmigrations */
export interface PgmigrationsInitializer {
  /** Default value: nextval('pgmigrations_id_seq'::regclass) */
  id?: PgmigrationsId;

  name: string;

  run_on: Date;
}

/** Represents the mutator for the table public.pgmigrations */
export interface PgmigrationsMutator {
  id?: PgmigrationsId;

  name?: string;

  run_on?: Date;
}