import type pg from 'pg';

/** One recovery attempt, as the service needs to reason about it. */
export interface ResetAttempt {
  id: string;
  userId: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  verifiedAt: Date | null;
}

/** Who is recovering: matched by national id AND email, both at once. */
export interface ResetTarget {
  userId: string;
  firstName: string;
  email: string;
}

export class PasswordResetRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * The identity check itself: cédula and email must point at the SAME row.
   * Both predicates live in one WHERE on purpose - resolving by cédula and then
   * comparing the email in code would make the mismatch observable through
   * timing, and would tempt someone into a "close enough" comparison later.
   *
   * Email is compared case-insensitively (nobody remembers how they typed it)
   * but the national id is not: it is a canonical `V-12345678` written by the
   * system, and loosening it would only widen what matches.
   */
  async findTarget(nationalId: string, email: string): Promise<ResetTarget | null> {
    const { rows } = await this.db.query<ResetTarget>(
      `SELECT u.id AS "userId", u.first_name AS "firstName", u.email
         FROM drivers d
         JOIN users u ON u.id = d.user_id
        WHERE d.national_id = $1
          AND lower(u.email) = lower($2)`,
      [nationalId, email],
    );
    return rows[0] ?? null;
  }

  /**
   * The CLIENT channel's identity check: a passenger recovers with his email
   * alone — he has no cédula on file, and the email is both his identifier and
   * where the code lands. The join against `clients` is what scopes the lookup:
   * a driver-only account does not match here (he has his own channel), so a
   * stranger cannot use this door to probe the affiliate list.
   */
  async findClientTarget(email: string): Promise<ResetTarget | null> {
    const { rows } = await this.db.query<ResetTarget>(
      `SELECT u.id AS "userId", u.first_name AS "firstName", u.email
         FROM clients c
         JOIN users u ON u.id = c.user_id
        WHERE lower(u.email) = lower($1)`,
      [email],
    );
    return rows[0] ?? null;
  }

  /**
   * Who to write to, by user id. The confirmation mail runs AFTER the change,
   * when the cédula/email the driver typed are no longer in hand - and going
   * back through `findTarget` would mean re-deriving them just to look up what
   * this answers in one query.
   */
  async findRecipient(userId: string): Promise<Omit<ResetTarget, 'userId'> | null> {
    const { rows } = await this.db.query<Omit<ResetTarget, 'userId'>>(
      `SELECT first_name AS "firstName", email FROM users
        WHERE id = $1 AND email IS NOT NULL`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /**
   * How many codes this account asked for since `since`. The rate limit reads
   * from the same rows it writes: no counter to keep in sync, and it survives a
   * restart because it was never in memory.
   */
  async countRecentRequests(userId: string, since: Date): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM password_reset_codes
        WHERE user_id = $1 AND created_at >= $2`,
      [userId, since],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Issues a code, spending any previous live attempt in the SAME statement
   * pair inside one transaction. Asking for a new code has to invalidate the
   * old one: two live codes double the guessing surface, and the partial unique
   * index would reject the insert anyway - better to mean it than to trip over
   * it.
   */
  async create(input: {
    userId: string;
    codeHash: string;
    expiresAt: Date;
    ip: string | null;
  }): Promise<string> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE password_reset_codes SET used_at = now()
          WHERE user_id = $1 AND used_at IS NULL`,
        [input.userId],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO password_reset_codes (user_id, code_hash, expires_at, requested_ip)
         VALUES ($1, $2, $3, $4)
         RETURNING id::text AS id`,
        [input.userId, input.codeHash, input.expiresAt, input.ip],
      );
      await client.query('COMMIT');
      return rows[0]!.id;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** The account's live attempt, if any. Spent and expired ones do not count. */
  async findLive(userId: string): Promise<ResetAttempt | null> {
    const { rows } = await this.db.query<ResetAttempt>(
      `SELECT id::text AS id, user_id AS "userId", code_hash AS "codeHash",
              expires_at AS "expiresAt", attempts, verified_at AS "verifiedAt"
         FROM password_reset_codes
        WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /** Same row by id, for the confirm step (which carries a token, not a cédula). */
  async findLiveById(id: string): Promise<ResetAttempt | null> {
    const { rows } = await this.db.query<ResetAttempt>(
      `SELECT id::text AS id, user_id AS "userId", code_hash AS "codeHash",
              expires_at AS "expiresAt", attempts, verified_at AS "verifiedAt"
         FROM password_reset_codes
        WHERE id = $1 AND used_at IS NULL AND expires_at > now()`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Counts a wrong try. Returns the new total so the caller can tell the driver
   * how many he has left - and can spend the attempt when they run out, without
   * a second round trip.
   */
  async registerFailure(id: string): Promise<number> {
    const { rows } = await this.db.query<{ attempts: number }>(
      `UPDATE password_reset_codes SET attempts = attempts + 1
        WHERE id = $1 RETURNING attempts`,
      [id],
    );
    return rows[0]?.attempts ?? 0;
  }

  /** Burns the attempt: out of tries, or superseded. */
  async spend(id: string): Promise<void> {
    await this.db.query(`UPDATE password_reset_codes SET used_at = now() WHERE id = $1`, [id]);
  }

  /**
   * Marks the code as correct. Guarded on `verified_at IS NULL` so a replay
   * cannot re-stamp an attempt that is already verified, and returns whether it
   * won: the verify step is what mints the token, and two tokens for one code
   * is exactly what the guard exists to prevent.
   */
  async markVerified(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE password_reset_codes SET verified_at = now()
        WHERE id = $1 AND verified_at IS NULL AND used_at IS NULL AND expires_at > now()`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * The password change: new hash and the attempt spent, in ONE transaction.
   * Split in two, a crash in between leaves a verified code still usable
   * against an account whose password already changed. Guarded on the attempt
   * still being live, so a replay of the same token writes nothing and the
   * caller sees `false`.
   */
  async consumeAndSetPassword(id: string, userId: string, passwordHash: string): Promise<boolean> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE password_reset_codes SET used_at = now()
          WHERE id = $1 AND used_at IS NULL AND verified_at IS NOT NULL AND expires_at > now()`,
        [id],
      );
      if (!rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [
        userId,
        passwordHash,
      ]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
