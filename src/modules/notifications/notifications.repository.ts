import type pg from 'pg';

export interface InboxItem {
  id: string;
  type: string;
  title: string;
  body: string;
  payload: unknown | null;
  createdAt: Date;
  readAt: Date | null;
}

export interface InboxPage {
  items: InboxItem[];
  /** Pass as `before` to get the next page; null when there is nothing older. */
  nextCursor: string | null;
  unread: number;
}

/**
 * Read side of the affiliate's inbox. The only SQL that touches `notifications`
 * for the app channel (the write side is `notification-writer.ts`, which the
 * services call from inside their own transactions).
 */
export class NotificationsRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * One page of HIS inbox, newest first.
   *
   * `deliver_after <= now()` is not a delivery detail leaking into the read
   * side - it is what the inbox MEANS. A reminder scheduled for Sunday
   * afternoon has not happened yet, and listing it today would show the
   * affiliate a notice about a week that has not started, dated as if it had.
   *
   * Keyset pagination on a descending bigint id, not OFFSET: notices arrive
   * while he scrolls, and OFFSET would shift the window under him and repeat or
   * skip rows.
   */
  async listForDriver(
    userId: string,
    opts: { limit: number; before?: string | undefined },
  ): Promise<InboxPage> {
    const { rows } = await this.db.query<InboxItem>(
      `SELECT id::text, type::text, title, body, payload,
              created_at AS "createdAt", read_at AS "readAt"
         FROM notifications
        WHERE user_id = $1
          AND deliver_after <= now()
          AND ($3::bigint IS NULL OR id < $3::bigint)
        ORDER BY id DESC
        LIMIT $2`,
      [userId, opts.limit + 1, opts.before ?? null],
    );

    // One row over the limit is the cheapest "is there more?" there is: no
    // count(*) over a table that only grows.
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;

    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      unread: await this.unreadCount(userId),
    };
  }

  /**
   * The badge. Rides inside `/driver-auth/me/account`, which the app already
   * asks for on every screen - NEVER in a call of its own: a second request that
   * fails without signal leaves the screen quietly lying (that was exactly the
   * "vehículo en uso" bug).
   */
  async unreadCount(userId: string): Promise<number> {
    const { rows } = await this.db.query<{ unread: string }>(
      `SELECT count(*)::text AS unread FROM notifications
        WHERE user_id = $1 AND read_at IS NULL AND deliver_after <= now()`,
      [userId],
    );
    return Number(rows[0]?.unread ?? 0);
  }

  /**
   * Marks one as read. Scoped by `user_id` in the WHERE, not checked afterwards:
   * another driver's id simply matches nothing. Idempotent - `read_at IS NULL`
   * keeps a second call from moving the timestamp.
   * Returns false when there was nothing to mark (unknown, or already read).
   */
  async markRead(userId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE notifications SET read_at = now()
        WHERE id = $2::bigint AND user_id = $1 AND read_at IS NULL`,
      [userId, id],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Registers (or re-points) the phone this driver receives push on.
   *
   * UPSERT ON THE TOKEN, not on (user, token), and that is the privacy control:
   * the token identifies a PHONE. When a second driver signs in on the same
   * handset, FCM hands the app the SAME token, and this moves the row to him
   * instead of leaving two owners — otherwise the previous driver's amounts and
   * rejection reasons keep landing on a screen that is no longer his.
   *
   * Also un-revokes: a token that comes back to life is normal (FCM rotates
   * them, the driver reinstalls, he signs back in), and its row keeps its history.
   */
  async registerDevice(userId: string, token: string, platform: string): Promise<void> {
    await this.db.query(
      `INSERT INTO device_tokens (user_id, token, platform)
       VALUES ($1, $2, $3::device_platform)
       ON CONFLICT (token) DO UPDATE
          SET user_id = EXCLUDED.user_id,
              platform = EXCLUDED.platform,
              last_seen_at = now(),
              revoked_at = NULL`,
      [userId, token, platform],
    );
  }

  /**
   * Logout. Revokes the token so the next person to use this phone does not
   * receive HIS notices — the other half of the door the global UNIQUE closes.
   * Scoped to the owner: a token that is not his is left alone.
   *
   * Revoked, not deleted: the row is the phone's history, and signing back in
   * brings it straight back.
   */
  async revokeDevice(userId: string, token: string): Promise<void> {
    await this.db.query(
      `UPDATE device_tokens SET revoked_at = now()
        WHERE token = $2 AND user_id = $1 AND revoked_at IS NULL`,
      [userId, token],
    );
  }

  /** Clears the badge in one go. Only what he could actually see. */
  async markAllRead(userId: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE notifications SET read_at = now()
        WHERE user_id = $1 AND read_at IS NULL AND deliver_after <= now()`,
      [userId],
    );
    return rowCount ?? 0;
  }
}
