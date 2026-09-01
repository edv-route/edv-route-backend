import type pg from 'pg';

/**
 * The ADMIN's view of the passengers (panel section «Clientes», 2026-08-31).
 * Read-only for now: the panel lists and searches; the detail card and the
 * suspend action come later. The passenger's own channel is `client-auth`.
 */

export interface ClientListItem {
  userId: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  /** `active` / `suspended`. */
  status: string;
  /**
   * Present only when this person is ALSO an affiliate (it lives on `drivers`).
   * The list shows it as a badge: an admin looking for a passenger who is one
   * of his own choferes should see it at a glance.
   */
  nationalId: string | null;
  createdAt: Date;
  /** Bucket PATH here; the service signs it before it leaves the API. */
  photoUrl: string | null;
}

export interface ClientListResult {
  items: ClientListItem[];
  total: number;
}

export class ClientsRepository {
  constructor(private readonly db: pg.Pool) {}

  async list(opts: {
    status?: string;
    search?: string;
    page: number;
    limit: number;
  }): Promise<ClientListResult> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (opts.status) {
      values.push(opts.status);
      where.push(`c.status = $${values.length}`);
    }
    if (opts.search) {
      values.push(`%${opts.search}%`);
      // Phone instead of the affiliates' cédula: it is what a passenger
      // identifies himself with over the phone.
      where.push(
        `(u.full_name ILIKE $${values.length} OR u.email ILIKE $${values.length} OR u.phone ILIKE $${values.length})`,
      );
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM clients c JOIN users u ON u.id = c.user_id ${whereSql}`,
      values,
    );

    values.push(opts.limit, (opts.page - 1) * opts.limit);
    const { rows } = await this.db.query<ClientListItem>(
      `SELECT c.user_id AS "userId", u.full_name AS "fullName", u.email, u.phone,
              c.status, c.created_at AS "createdAt", d.national_id AS "nationalId",
              u.photo_url AS "photoUrl"
         FROM clients c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN drivers d ON d.user_id = c.user_id
       ${whereSql}
       ORDER BY c.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    return { items: rows, total: Number(countResult.rows[0]?.count ?? 0) };
  }
}
