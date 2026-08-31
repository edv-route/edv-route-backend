import type pg from 'pg';
import type Users from '../../db/models/public/Users.js';
import type Clients from '../../db/models/public/Clients.js';
import type { Camelize } from '../../db/case-types.js';

/**
 * Everything the passenger side reads and writes (proposal:
 * docs/proposals/cliente).
 *
 * A client is a `users` row plus a `clients` row, exactly like a driver. Every
 * query here joins the two, and the person's own data (names, email, phone,
 * photo) lives in `users` — shared with the driver side on purpose, because the
 * same human can be both.
 */

type UserRow = Camelize<Users>;
type ClientRow = Camelize<Clients>;

/** What the app shows about the signed-in client. */
export type ClientProfile = Pick<
  UserRow,
  'fullName' | 'firstName' | 'middleName' | 'lastName' | 'secondLastName' | 'email' | 'phone' | 'photoUrl' | 'birthDate' | 'address'
> &
  Pick<ClientRow, 'status'> & { userId: string; nationalId: string | null; createdAt: Date };

/** The profile plus the hash, for the login check only. */
export type ClientAuthRecord = ClientProfile & { passwordHash: string | null };

const PROFILE_COLUMNS = `
  c.user_id AS "userId",
  u.full_name AS "fullName",
  u.first_name AS "firstName",
  u.middle_name AS "middleName",
  u.last_name AS "lastName",
  u.second_last_name AS "secondLastName",
  u.email,
  u.phone,
  u.photo_url AS "photoUrl",
  u.birth_date AS "birthDate",
  u.address,
  c.status,
  c.created_at AS "createdAt",
  d.national_id AS "nationalId"
`;

/**
 * The national id lives on `drivers`, not on `users`. A client who is also an
 * affiliate therefore has one; a client who is only a client does not, and the
 * LEFT JOIN is what lets both be true without a second query.
 */
const PROFILE_FROM = `
  FROM clients c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN drivers d ON d.user_id = c.user_id
`;

export class ClientAuthRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Finds a client by whatever he typed: email or phone.
   *
   * ONE query with an OR rather than two attempts, so an address that exists
   * and one that does not cost the same — two queries would make the difference
   * observable by timing, which is how account enumeration starts.
   *
   * Both columns are unique, so this can never return two people.
   */
  async findAuthByIdentifier(identifier: string): Promise<ClientAuthRecord | null> {
    const { rows } = await this.db.query<ClientAuthRecord>(
      `SELECT ${PROFILE_COLUMNS}, u.password_hash AS "passwordHash"
       ${PROFILE_FROM}
       WHERE lower(u.email) = lower($1) OR u.phone = $1`,
      [identifier],
    );
    return rows[0] ?? null;
  }

  /** The stored hash, for confirming the current password on a change. */
  async findPasswordHash(userId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ passwordHash: string | null }>(
      'SELECT password_hash AS "passwordHash" FROM users WHERE id = $1',
      [userId],
    );
    return rows[0]?.passwordHash ?? null;
  }

  async findProfileById(userId: string): Promise<ClientProfile | null> {
    const { rows } = await this.db.query<ClientProfile>(
      `SELECT ${PROFILE_COLUMNS} ${PROFILE_FROM} WHERE c.user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /** Whether this person already has a client side. Used to avoid duplicates. */
  async existsClient(userId: string): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM clients WHERE user_id = $1', [userId]);
    return rows.length > 0;
  }

  /** Looks up an existing person by email or phone, whatever side they came in on. */
  async findUserByEmailOrPhone(
    email: string,
    phone: string | null,
  ): Promise<{ id: string; email: string | null; phone: string | null } | null> {
    const { rows } = await this.db.query<{ id: string; email: string | null; phone: string | null }>(
      `SELECT id, email, phone FROM users
        WHERE lower(email) = lower($1) OR ($2::text IS NOT NULL AND phone = $2)
        LIMIT 1`,
      [email, phone],
    );
    return rows[0] ?? null;
  }

  /**
   * Creates the person and their client side in ONE transaction.
   *
   * Two statements without a transaction can leave a `users` row with no
   * `clients` row: an account that exists, cannot sign in anywhere, and blocks
   * its own email from being registered again.
   */
  async createClient(input: {
    firstName: string;
    middleName: string | null;
    lastName: string;
    secondLastName: string | null;
    fullName: string;
    email: string;
    phone: string | null;
    birthDate: string | null;
    address: string | null;
    passwordHash: string;
  }): Promise<string> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (first_name, middle_name, last_name, second_last_name,
                            full_name, email, phone, birth_date, address, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          input.firstName,
          input.middleName,
          input.lastName,
          input.secondLastName,
          input.fullName,
          input.email,
          input.phone,
          input.birthDate,
          input.address,
          input.passwordHash,
        ],
      );
      const userId = rows[0]!.id;
      await client.query(
        `INSERT INTO clients (user_id, status, accepted_privacy_at)
         VALUES ($1, 'active', now())`,
        [userId],
      );
      await client.query('COMMIT');
      return userId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Adds the client side to somebody who already exists — an affiliate who
   * needs a ride. Nothing about the person is touched: he keeps his name, his
   * password and his driver side exactly as they were.
   */
  async attachClientTo(userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO clients (user_id, status, accepted_privacy_at)
       VALUES ($1, 'active', now())
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
  }

  /** Partial update of the person's own data. Only what was sent is written. */
  async updateProfile(
    userId: string,
    changes: Partial<{
      firstName: string;
      middleName: string | null;
      lastName: string;
      secondLastName: string | null;
      fullName: string;
      email: string;
      phone: string | null;
      birthDate: string | null;
      address: string | null;
      passwordHash: string;
    }>,
  ): Promise<void> {
    const columns: Record<string, string> = {
      firstName: 'first_name',
      middleName: 'middle_name',
      lastName: 'last_name',
      secondLastName: 'second_last_name',
      fullName: 'full_name',
      email: 'email',
      phone: 'phone',
      birthDate: 'birth_date',
      address: 'address',
      passwordHash: 'password_hash',
    };

    const sets: string[] = [];
    const values: unknown[] = [userId];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in changes)) continue;
      values.push(changes[key as keyof typeof changes]);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) return;

    await this.db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, values);
  }

  /** Stored bucket PATH, never a URL: the signature is minted per read. */
  async setPhotoPath(userId: string, path: string): Promise<string | null> {
    const { rows } = await this.db.query<{ photoUrl: string | null }>(
      'SELECT photo_url AS "photoUrl" FROM users WHERE id = $1',
      [userId],
    );
    await this.db.query('UPDATE users SET photo_url = $2 WHERE id = $1', [userId, path]);
    return rows[0]?.photoUrl ?? null;
  }
}
