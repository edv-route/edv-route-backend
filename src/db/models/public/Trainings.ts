import type { default as TrainingStatus } from './TrainingStatus.js';
import type { AdminsId } from './Admins.js';

/** Identifier type for public.trainings */
export type TrainingsId = number & { __brand: 'public.trainings' };

/** Represents the table public.trainings */
export default interface Trainings {
  id: TrainingsId;

  title: string;

  description: string | null;

  location: string | null;

  starts_at: Date;

  ends_at: Date | null;

  capacity: number | null;

  status: TrainingStatus;

  created_by: AdminsId | null;

  created_at: Date;

  updated_at: Date;
}

/** Represents the initializer for the table public.trainings */
export interface TrainingsInitializer {
  id?: TrainingsId;

  title: string;

  description?: string | null;

  location?: string | null;

  starts_at: Date;

  ends_at?: Date | null;

  capacity?: number | null;

  /** Default value: 'scheduled'::training_status */
  status?: TrainingStatus;

  created_by?: AdminsId | null;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;
}

/** Represents the mutator for the table public.trainings */
export interface TrainingsMutator {
  id?: TrainingsId;

  title?: string;

  description?: string | null;

  location?: string | null;

  starts_at?: Date;

  ends_at?: Date | null;

  capacity?: number | null;

  status?: TrainingStatus;

  created_by?: AdminsId | null;

  created_at?: Date;

  updated_at?: Date;
}