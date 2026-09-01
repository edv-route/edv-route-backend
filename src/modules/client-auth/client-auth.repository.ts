import type pg from 'pg';
import type Users from '../../db/models/public/Users.js';
import type Clients from '../../db/models/public/Clients.js';
import type { Camelize } from '../../db/case-types.js';

/**
 * Everything the passenger side reads and writes (proposal:
 * docs/proposals/cliente).
 *
 * A client is a `users` row plus a `clients` row, exactly like a driver. Since
 * 2026-09-01 (independent roles, decision by Luis) each side owns its OWN
 * email, phone and password: the client's live HERE on `clients`; the
 * driver's stay on `users`, where the whole money side reads them. What both
 * share is the PERSON on `users`: names, birth date, address, photo.
 */

type UserRow = Camelize<Users>;
type ClientRow = Camelize<Clients>;

/** What the app shows about the signed-in client. */
export type ClientProfile = Pick<
  UserRow,
  'fullName' | 'firstName' | 'middleName' | 'lastName' | 'secondLastName' | 'photoUrl' | 'birthDate' | 'address'
> &
  Pick<ClientRow, 'status' | 'email' | 'phone'> & {
    userId: string;
    nationalId: string | null;
    createdAt: Date;
  };

/** The profile plus the hash, for the login check only. */
export type ClientAuthRecord = ClientProfile & { passwordHash: string | null };

const PROFILE_COLUMNS = `
  c.user_id AS "userId",
  u.full_name AS "fullName",
  u.first_name AS "firstName",
  u.middle_name AS "middleName",
  u.last_name AS "lastName",
  u.second_last_name AS "secondLastName",
  -- The ROLE's own contact, not the person's (independent roles, 2026-09-01).
  c.email,
  c.phone,
  u.photo_url AS "photoUrl",
  u.birth_date AS "birthDate",
  u.address,
  c.status,
  c.created_at AS "createdAt",
  -- The office-VERIFIED cédula (drivers) wins over the self-declared one
  -- (clients); a person who is both never has the latter.
  COALESCE(d.national_id, c.national_id) AS "nationalId"
`;

const PROFILE_FROM = `
  FROM clients c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN drivers d ON d.user_id = c.user_id
`;

export class ClientAuthRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Finds a client by whatever he typed: email or phone — HIS OWN, on
   * `clients`. ONE query with an OR rather than two attempts, so an address
   * that exists and one that does not cost the same (timing-safe).
   */
  async findAuthByIdentifier(identifier: string): Promise<ClientAuthRecord | null> {
    const { rows } = await this.db.query<ClientAuthRecord>(
      `SELECT ${PROFILE_COLUMNS}, c.password_hash AS "passwordHash"
       ${PROFILE_FROM}
       WHERE lower(c.email) = lower($1) OR c.phone = $1`,
      [identifier],
    );
    return rows[0] ?? null;
  }

  /** The client's own stored hash, for confirming the current password. */
  async findPasswordHash(userId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ passwordHash: string | null }>(
      'SELECT password_hash AS "passwordHash" FROM clients WHERE user_id = $1',
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

  /**
   * The cédula-first lookup (step 0 of the registration, Luis 2026-09-01):
   * who holds this cédula — on either side — and whether they already have
   * the client hat. `driverPasswordHash` is the proof the ATTACH step
   * verifies: the password the person already has (his driver one — a person
   * without the client side keeps his app password on `users`).
   */
  async findPersonByCedula(nationalId: string): Promise<{
    id: string;
    hasClient: boolean;
    driverPasswordHash: string | null;
  } | null> {
    const { rows } = await this.db.query<{
      id: string;
      hasClient: boolean;
      driverPasswordHash: string | null;
    }>(
      `SELECT u.id,
              (c.user_id IS NOT NULL) AS "hasClient",
              u.password_hash AS "driverPasswordHash"
         FROM users u
         LEFT JOIN drivers d ON d.user_id = u.id
         LEFT JOIN clients c ON c.user_id = u.id
        WHERE d.national_id = $1 OR c.national_id = $1
        LIMIT 1`,
      [nationalId],
    );
    return rows[0] ?? null;
  }

  /**
   * Whether SOMEBODY ELSE already holds this cédula — on either side (a
   * driver's verified one or another client's declared one). A unique index
   * cannot span two tables, so this check lives here.
   */
  async cedulaTakenByOther(nationalId: string, userId: string | null): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM drivers WHERE national_id = $1 AND ($2::uuid IS NULL OR user_id <> $2)
       UNION ALL
       SELECT 1 FROM clients WHERE national_id = $1 AND ($2::uuid IS NULL OR user_id <> $2)
       LIMIT 1`,
      [nationalId, userId],
    );
    return rows.length > 0;
  }

  /**
   * Whether another CLIENT already uses this email or phone (this role's
   * identifiers are unique within the role, 2026-09-01).
   */
  async contactTakenByOtherClient(
    email: string | null,
    phone: string | null,
    userId: string | null,
  ): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM clients
        WHERE (($1::text IS NOT NULL AND lower(email) = lower($1))
            OR ($2::text IS NOT NULL AND phone = $2))
          AND ($3::uuid IS NULL OR user_id <> $3)
        LIMIT 1`,
      [email, phone, userId],
    );
    return rows.length > 0;
  }

  /**
   * Creates the person and their client side in ONE transaction. The person
   * (`users`) gets names, birth date and address; the ROLE (`clients`) gets
   * its own email, phone and password — `users` contact stays NULL on
   * purpose: a pure client has no driver side to feed.
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
    nationalId: string | null;
    passwordHash: string;
  }): Promise<string> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (first_name, middle_name, last_name, second_last_name,
                            full_name, birth_date, address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          input.firstName,
          input.middleName,
          input.lastName,
          input.secondLastName,
          input.fullName,
          input.birthDate,
          input.address,
        ],
      );
      const userId = rows[0]!.id;
      await client.query(
        `INSERT INTO clients (user_id, status, accepted_privacy_at, national_id,
                              email, phone, password_hash)
         VALUES ($1, 'active', now(), $2, $3, $4, $5)`,
        [userId, input.nationalId, input.email, input.phone, input.passwordHash],
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
   * needs a ride (short form). The role arrives with its OWN email, phone and
   * password; nothing about the person or his driver side is touched.
   */
  async attachClientTo(
    userId: string,
    role: { email: string; phone: string | null; passwordHash: string },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO clients (user_id, status, accepted_privacy_at, email, phone, password_hash)
       VALUES ($1, 'active', now(), $2, $3, $4)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, role.email, role.phone, role.passwordHash],
    );
  }

  /**
   * Partial update. Person data (names, birth, address) goes to `users`;
   * the role's own data (email, phone, password) goes to `clients`. Only what
   * was sent is written.
   */
  async updateProfile(
    userId: string,
    changes: Partial<{
      firstName: string;
      middleName: string | null;
      lastName: string;
      secondLastName: string | null;
      fullName: string;
      birthDate: string | null;
      address: string | null;
      email: string;
      phone: string | null;
      passwordHash: string;
    }>,
  ): Promise<void> {
    const userColumns: Record<string, string> = {
      firstName: 'first_name',
      middleName: 'middle_name',
      lastName: 'last_name',
      secondLastName: 'second_last_name',
      fullName: 'full_name',
      birthDate: 'birth_date',
      address: 'address',
    };
    const clientColumns: Record<string, string> = {
      email: 'email',
      phone: 'phone',
      passwordHash: 'password_hash',
    };

    const apply = async (table: string, columns: Record<string, string>) => {
      const sets: string[] = [];
      const values: unknown[] = [userId];
      for (const [key, column] of Object.entries(columns)) {
        if (!(key in changes)) continue;
        values.push(changes[key as keyof typeof changes]);
        sets.push(`${column} = $${values.length}`);
      }
      if (sets.length === 0) return;
      const where = table === 'users' ? 'id = $1' : 'user_id = $1';
      await this.db.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${where}`, values);
    };

    await apply('users', userColumns);
    await apply('clients', clientColumns);
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
