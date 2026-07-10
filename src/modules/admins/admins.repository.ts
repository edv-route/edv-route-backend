import type pg from 'pg';
import type Admins from '../../db/models/public/Admins.js';
import type { Camelize } from '../../db/case-types.js';

/** Public shape of an admin - derived from the generated DB row model. */
export type AdminRecord = Camelize<
  Omit<Admins, 'password_hash' | 'failed_login_attempts' | 'locked_until'>
>;

/** Full row incl. credential/lockout columns; never leaves the auth flow. */
export type AdminAuthRecord = Camelize<Admins>;

export interface CreateAdminData {
  username: string;
  email: string | null;
  fullName: string;
  passwordHash: string;
  createdBy: string;
}

export interface UpdateAdminData {
  fullName?: string;
  email?: string | null;
  status?: 'active' | 'suspended';
}

const PUBLIC_COLUMNS = `
  id, username, email, full_name AS "fullName", role, status,
  last_login_at AS "lastLoginAt", created_by AS "createdBy",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

export class AdminsRepository {
  constructor(private readonly db: pg.Pool) {}

  async list(): Promise<AdminRecord[]> {
    const { rows } = await this.db.query<AdminRecord>(
      `SELECT ${PUBLIC_COLUMNS} FROM admins ORDER BY created_at`,
    );
    return rows;
  }

  async findById(id: string): Promise<AdminRecord | null> {
    const { rows } = await this.db.query<AdminRecord>(
      `SELECT ${PUBLIC_COLUMNS} FROM admins WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findAuthByUsername(username: string): Promise<AdminAuthRecord | null> {
    const { rows } = await this.db.query<AdminAuthRecord>(
      `SELECT ${PUBLIC_COLUMNS},
              password_hash AS "passwordHash",
              failed_login_attempts AS "failedLoginAttempts",
              locked_until AS "lockedUntil"
       FROM admins WHERE username = $1`,
      [username],
    );
    return rows[0] ?? null;
  }

  async create(data: CreateAdminData): Promise<AdminRecord> {
    const { rows } = await this.db.query<AdminRecord>(
      `INSERT INTO admins (username, email, full_name, password_hash, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PUBLIC_COLUMNS}`,
      [data.username, data.email, data.fullName, data.passwordHash, data.createdBy],
    );
    return rows[0]!;
  }

  async update(id: string, data: UpdateAdminData): Promise<AdminRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (data.fullName !== undefined) {
      values.push(data.fullName);
      sets.push(`full_name = $${values.length}`);
    }
    if (data.email !== undefined) {
      values.push(data.email);
      sets.push(`email = $${values.length}`);
    }
    if (data.status !== undefined) {
      values.push(data.status);
      sets.push(`status = $${values.length}`);
    }
    if (sets.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const { rows } = await this.db.query<AdminRecord>(
      `UPDATE admins SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${PUBLIC_COLUMNS}`,
      values,
    );
    return rows[0] ?? null;
  }

  async updatePassword(id: string, passwordHash: string): Promise<boolean> {
    const result = await this.db.query(
      'UPDATE admins SET password_hash = $2 WHERE id = $1',
      [id, passwordHash],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Increments the failure counter and locks the account past the threshold. */
  async recordLoginFailure(id: string, maxAttempts: number, lockMinutes: number): Promise<void> {
    await this.db.query(
      `UPDATE admins SET
         failed_login_attempts = failed_login_attempts + 1,
         locked_until = CASE
           WHEN failed_login_attempts + 1 >= $2
             THEN now() + make_interval(mins => $3)
           ELSE locked_until
         END
       WHERE id = $1`,
      [id, maxAttempts, lockMinutes],
    );
  }

  async recordLoginSuccess(id: string): Promise<void> {
    await this.db.query(
      `UPDATE admins SET
         failed_login_attempts = 0,
         locked_until = NULL,
         last_login_at = now()
       WHERE id = $1`,
      [id],
    );
  }
}
