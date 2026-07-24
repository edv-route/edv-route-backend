import type { TrainingsId } from './Trainings.js';
import type { UsersId } from './Users.js';
import type { default as TrainingAttendeeStatus } from './TrainingAttendeeStatus.js';
import type { AdminsId } from './Admins.js';

/** Identifier type for public.training_attendees */
export type TrainingAttendeesId = string & { __brand: 'public.training_attendees' };

/** Represents the table public.training_attendees */
export default interface TrainingAttendees {
  id: TrainingAttendeesId;

  training_id: TrainingsId;

  driver_id: UsersId;

  status: TrainingAttendeeStatus;

  registered_by: AdminsId | null;

  created_at: Date;

  updated_at: Date;
}

/** Represents the initializer for the table public.training_attendees */
export interface TrainingAttendeesInitializer {
  id?: TrainingAttendeesId;

  training_id: TrainingsId;

  driver_id: UsersId;

  /** Default value: 'registered'::training_attendee_status */
  status?: TrainingAttendeeStatus;

  registered_by?: AdminsId | null;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;
}

/** Represents the mutator for the table public.training_attendees */
export interface TrainingAttendeesMutator {
  id?: TrainingAttendeesId;

  training_id?: TrainingsId;

  driver_id?: UsersId;

  status?: TrainingAttendeeStatus;

  registered_by?: AdminsId | null;

  created_at?: Date;

  updated_at?: Date;
}