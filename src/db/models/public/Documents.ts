import type { RequirementsId } from './Requirements.js';
import type { UsersId } from './Users.js';
import type { VehiclesId } from './Vehicles.js';
import type { default as DocumentStatus } from './DocumentStatus.js';
import type { AdminsId } from './Admins.js';

/** Identifier type for public.documents */
export type DocumentsId = string & { __brand: 'public.documents' };

/** Represents the table public.documents */
export default interface Documents {
  id: DocumentsId;

  requirement_id: RequirementsId;

  driver_id: UsersId | null;

  vehicle_id: VehiclesId | null;

  file_url: string | null;

  expires_at: Date | null;

  status: DocumentStatus;

  uploaded_by: AdminsId | null;

  created_at: Date;

  updated_at: Date;
}

/** Represents the initializer for the table public.documents */
export interface DocumentsInitializer {
  /** Default value: gen_random_uuid() */
  id?: DocumentsId;

  requirement_id: RequirementsId;

  driver_id?: UsersId | null;

  vehicle_id?: VehiclesId | null;

  file_url?: string | null;

  expires_at?: Date | null;

  /** Default value: 'valid'::document_status */
  status?: DocumentStatus;

  uploaded_by?: AdminsId | null;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;
}

/** Represents the mutator for the table public.documents */
export interface DocumentsMutator {
  id?: DocumentsId;

  requirement_id?: RequirementsId;

  driver_id?: UsersId | null;

  vehicle_id?: VehiclesId | null;

  file_url?: string | null;

  expires_at?: Date | null;

  status?: DocumentStatus;

  uploaded_by?: AdminsId | null;

  created_at?: Date;

  updated_at?: Date;
}