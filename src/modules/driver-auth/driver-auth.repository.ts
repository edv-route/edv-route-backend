import type pg from 'pg';
import type Drivers from '../../db/models/public/Drivers.js';
import type Users from '../../db/models/public/Users.js';
import type { Camelize } from '../../db/case-types.js';

type DriverRow = Camelize<Drivers>;
type UserRow = Camelize<Users>;

/** Public driver profile returned by the app auth flow. */
export type DriverProfile = Pick<UserRow, 'fullName' | 'phone' | 'email' | 'photoUrl'> &
  Pick<DriverRow, 'nationalId' | 'status' | 'registrationStep' | 'isAvailable' | 'avgRating'> & {
    userId: string;
  };

/** Profile + credential hash; the hash never leaves the auth service. */
export type DriverAuthRecord = DriverProfile & { passwordHash: string | null };

const PROFILE_COLUMNS = `
  u.id AS "userId", u.full_name AS "fullName", u.phone, u.email, u.photo_url AS "photoUrl",
  d.national_id AS "nationalId", d.status, d.registration_step AS "registrationStep",
  d.is_available AS "isAvailable", d.avg_rating AS "avgRating"
`;

export class DriverAuthRepository {
  constructor(private readonly db: pg.Pool) {}

  /** Credential lookup by national id (cédula). Includes the password hash. */
  async findAuthByNationalId(nationalId: string): Promise<DriverAuthRecord | null> {
    const { rows } = await this.db.query<DriverAuthRecord>(
      `SELECT ${PROFILE_COLUMNS}, u.password_hash AS "passwordHash"
       FROM drivers d JOIN users u ON u.id = d.user_id
       WHERE d.national_id = $1`,
      [nationalId],
    );
    return rows[0] ?? null;
  }

  /** Public profile by user id (for the authenticated /me endpoint). */
  async findProfileById(userId: string): Promise<DriverProfile | null> {
    const { rows } = await this.db.query<DriverProfile>(
      `SELECT ${PROFILE_COLUMNS}
       FROM drivers d JOIN users u ON u.id = d.user_id
       WHERE u.id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }
}
