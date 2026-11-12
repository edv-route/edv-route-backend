import type { UsersId } from './Users.js';
import type { default as IdentityPhotoKind } from './IdentityPhotoKind.js';
import type { default as IdentityPhotoStatus } from './IdentityPhotoStatus.js';
import type { AdminsId } from './Admins.js';

/** Identifier type for public.identity_photos */
export type IdentityPhotosId = string & { __brand: 'public.identity_photos' };

/** Represents the table public.identity_photos */
export default interface IdentityPhotos {
  id: IdentityPhotosId;

  user_id: UsersId;

  kind: IdentityPhotoKind;

  file_path: string;

  status: IdentityPhotoStatus;

  rejection_reason: string | null;

  reviewed_by: AdminsId | null;

  reviewed_at: Date | null;

  superseded_at: Date | null;

  created_at: Date;
}

/** Represents the initializer for the table public.identity_photos */
export interface IdentityPhotosInitializer {
  /** Default value: gen_random_uuid() */
  id?: IdentityPhotosId;

  user_id: UsersId;

  kind: IdentityPhotoKind;

  file_path: string;

  /** Default value: 'pending'::identity_photo_status */
  status?: IdentityPhotoStatus;

  rejection_reason?: string | null;

  reviewed_by?: AdminsId | null;

  reviewed_at?: Date | null;

  superseded_at?: Date | null;

  /** Default value: now() */
  created_at?: Date;
}

/** Represents the mutator for the table public.identity_photos */
export interface IdentityPhotosMutator {
  id?: IdentityPhotosId;

  user_id?: UsersId;

  kind?: IdentityPhotoKind;

  file_path?: string;

  status?: IdentityPhotoStatus;

  rejection_reason?: string | null;

  reviewed_by?: AdminsId | null;

  reviewed_at?: Date | null;

  superseded_at?: Date | null;

  created_at?: Date;
}