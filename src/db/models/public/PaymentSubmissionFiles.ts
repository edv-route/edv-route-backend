import type { PaymentSubmissionsId } from './PaymentSubmissions.js';

/** Identifier type for public.payment_submission_files */
export type PaymentSubmissionFilesId = string & { __brand: 'public.payment_submission_files' };

/** Represents the table public.payment_submission_files */
export default interface PaymentSubmissionFiles {
  id: PaymentSubmissionFilesId;

  submission_id: PaymentSubmissionsId;

  storage_path: string;

  position: number;

  created_at: Date;
}

/** Represents the initializer for the table public.payment_submission_files */
export interface PaymentSubmissionFilesInitializer {
  /** Default value: gen_random_uuid() */
  id?: PaymentSubmissionFilesId;

  submission_id: PaymentSubmissionsId;

  storage_path: string;

  /** Default value: 1 */
  position?: number;

  /** Default value: now() */
  created_at?: Date;
}

/** Represents the mutator for the table public.payment_submission_files */
export interface PaymentSubmissionFilesMutator {
  id?: PaymentSubmissionFilesId;

  submission_id?: PaymentSubmissionsId;

  storage_path?: string;

  position?: number;

  created_at?: Date;
}