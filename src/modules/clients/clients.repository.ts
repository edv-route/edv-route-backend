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
   * The verified one (`drivers`) when the person is also an affiliate, else
   * the self-declared one (`clients`); null only on legacy rows registered
   * before the cédula became mandatory (2026-08-31).
   */
  nationalId: string | null;
  /** Whether this person ALSO drives for the gremio — shown as a badge. */
  isAffiliate: boolean;
  createdAt: Date;
  /** Bucket PATH here; the service signs it before it leaves the API. */
  photoUrl: string | null;
}

export interface ClientListResult {
  items: ClientListItem[];
  total: number;
}

/** The detail card: everything the list shows plus the person's extras. */
export interface ClientDetail extends ClientListItem {
  address: string | null;
  birthDate: Date | null;
  /** When he accepted the privacy policy at registration; null on legacy rows. */
  acceptedPrivacyAt: Date | null;
  /** Registration channel context: whether he self-registered from the app. */
  source: 'app';
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
      // The ROLE's own contact (clients.email/phone, independent roles
      // 2026-09-01); the name is the person's.
      where.push(
        `(u.full_name ILIKE $${values.length} OR c.email ILIKE $${values.length}
          OR c.phone ILIKE $${values.length}
          OR COALESCE(d.national_id, c.national_id) ILIKE $${values.length})`,
      );
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM clients c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN drivers d ON d.user_id = c.user_id
       ${whereSql}`,
      values,
    );

    values.push(opts.limit, (opts.page - 1) * opts.limit);
    const { rows } = await this.db.query<ClientListItem>(
      `SELECT c.user_id AS "userId", u.full_name AS "fullName", c.email, c.phone,
              c.status, c.created_at AS "createdAt",
              COALESCE(d.national_id, c.national_id) AS "nationalId",
              (d.user_id IS NOT NULL) AS "isAffiliate",
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

  async findDetail(userId: string): Promise<ClientDetail | null> {
    const { rows } = await this.db.query<ClientDetail>(
      `SELECT c.user_id AS "userId", u.full_name AS "fullName", c.email, c.phone,
              c.status, c.created_at AS "createdAt",
              COALESCE(d.national_id, c.national_id) AS "nationalId",
              (d.user_id IS NOT NULL) AS "isAffiliate",
              u.photo_url AS "photoUrl",
              u.address, u.birth_date AS "birthDate",
              c.accepted_privacy_at AS "acceptedPrivacyAt",
              'app' AS source
         FROM clients c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN drivers d ON d.user_id = c.user_id
        WHERE c.user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }
}
