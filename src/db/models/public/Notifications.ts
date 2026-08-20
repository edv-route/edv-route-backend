import type { UsersId } from './Users.js';
import type { default as NotificationType } from './NotificationType.js';
import type { default as NotificationPushStatus } from './NotificationPushStatus.js';

/** Identifier type for public.notifications */
export type NotificationsId = string & { __brand: 'public.notifications' };

/** Represents the table public.notifications */
export default interface Notifications {
  id: NotificationsId;

  user_id: UsersId;

  type: NotificationType;

  title: string;

  body: string;

  payload: unknown | null;

  read_at: Date | null;

  deliver_after: Date;

  push_status: NotificationPushStatus;

  push_attempts: number;

  push_sent_at: Date | null;

  push_error: string | null;

  created_at: Date;
}

/** Represents the initializer for the table public.notifications */
export interface NotificationsInitializer {
  id?: NotificationsId;

  user_id: UsersId;

  type: NotificationType;

  title: string;

  body: string;

  payload?: unknown | null;

  read_at?: Date | null;

  /** Default value: now() */
  deliver_after?: Date;

  /** Default value: 'pending'::notification_push_status */
  push_status?: NotificationPushStatus;

  /** Default value: 0 */
  push_attempts?: number;

  push_sent_at?: Date | null;

  push_error?: string | null;

  /** Default value: now() */
  created_at?: Date;
}

/** Represents the mutator for the table public.notifications */
export interface NotificationsMutator {
  id?: NotificationsId;

  user_id?: UsersId;

  type?: NotificationType;

  title?: string;

  body?: string;

  payload?: unknown | null;

  read_at?: Date | null;

  deliver_after?: Date;

  push_status?: NotificationPushStatus;

  push_attempts?: number;

  push_sent_at?: Date | null;

  push_error?: string | null;

  created_at?: Date;
}