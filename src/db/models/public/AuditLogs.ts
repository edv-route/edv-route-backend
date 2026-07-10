import type { AdminsId } from './Admins.js';
import type { UsersId } from './Users.js';

/** Identifier type for public.audit_logs */
export type AuditLogsId = string & { __brand: 'public.audit_logs' };

/** Represents the table public.audit_logs */
export default interface AuditLogs {
  id: AuditLogsId;

  actor_admin_id: AdminsId | null;

  actor_user_id: UsersId | null;

  event_type: string;

  entity: string;

  entity_id: string | null;

  data: unknown | null;

  created_at: Date;
}

/** Represents the initializer for the table public.audit_logs */
export interface AuditLogsInitializer {
  id?: AuditLogsId;

  actor_admin_id?: AdminsId | null;

  actor_user_id?: UsersId | null;

  event_type: string;

  entity: string;

  entity_id?: string | null;

  data?: unknown | null;

  /** Default value: now() */
  created_at?: Date;
}

/** Represents the mutator for the table public.audit_logs */
export interface AuditLogsMutator {
  id?: AuditLogsId;

  actor_admin_id?: AdminsId | null;

  actor_user_id?: UsersId | null;

  event_type?: string;

  entity?: string;

  entity_id?: string | null;

  data?: unknown | null;

  created_at?: Date;
}