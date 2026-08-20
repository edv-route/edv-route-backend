import type pg from 'pg';
import type NotificationType from '../../db/models/public/NotificationType.js';

/**
 * Pool OR transaction client. This is the one real difference with
 * `writeAudit`, and it is not a convenience: the audit entry is written AFTER
 * the mutation succeeds, while the notice must be written INSIDE the same
 * transaction as the fact it announces. Take the pool here and a reverted
 * payment leaves an orphan notice telling the driver about money that no
 * longer moved.
 */
export type NotificationDb = Pick<pg.Pool, 'query'>;

export interface NotificationEntry {
  /** Recipient (users.id). Drivers today; the column is not driver-specific. */
  userId: string;
  type: NotificationType;
  /**
   * Already rendered, both of them. The phone must never compose the text: the
   * inbox would then disagree with the push, and fixing a wording would mean
   * shipping an APK.
   */
  title: string;
  body: string;
  /** Structured context the app acts on: amounts, invoice ids, rejection reason. */
  payload?: unknown;
  /**
   * Hold the push until this moment (the inbox shows the row immediately either
   * way). This is how a notice stays atomic with its fact while being delivered
   * at a humane hour: the debt engine marks arrears at 00:05 and schedules the
   * message for ~7:00 am in the same transaction. Omit for "as soon as possible".
   */
  deliverAfter?: Date;
}

const INSERT_SQL = `
  INSERT INTO notifications (user_id, type, title, body, payload, deliver_after)
  VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))
`;

function params(entry: NotificationEntry): unknown[] {
  return [
    entry.userId,
    entry.type,
    entry.title,
    entry.body,
    entry.payload === undefined || entry.payload === null ? null : JSON.stringify(entry.payload),
    entry.deliverAfter ?? null,
  ];
}

/**
 * Single write path into the outbox, shared by every service and scheduler.
 * Deliberately does nothing but INSERT: no vendor call, no HTTP, no retry loop.
 * The dispatcher (src/plugins/notification-dispatcher.ts) is what sends, out of
 * band - calling Firebase from here would hang the debt engine tick behind a
 * network round trip and announce a commit that has not happened yet.
 */
export async function writeNotification(
  db: NotificationDb,
  entry: NotificationEntry,
): Promise<void> {
  await db.query(INSERT_SQL, params(entry));
}

/**
 * Bulk insert for the engine tick, which produces one notice per affected
 * driver: a single statement instead of N round trips inside the transaction
 * that is already holding money rows locked.
 */
export async function writeNotifications(
  db: NotificationDb,
  entries: NotificationEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const values: unknown[] = [];
  const tuples = entries.map((entry, i) => {
    const base = i * 6;
    values.push(...params(entry));
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, COALESCE($${base + 6}::timestamptz, now()))`;
  });

  await db.query(
    `INSERT INTO notifications (user_id, type, title, body, payload, deliver_after)
     VALUES ${tuples.join(', ')}`,
    values,
  );
}
