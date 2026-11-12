import type pg from 'pg';
import type IdentityPhotos from '../../db/models/public/IdentityPhotos.js';
import type IdentityPhotoKind from '../../db/models/public/IdentityPhotoKind.js';
import type IdentityPhotoStatus from '../../db/models/public/IdentityPhotoStatus.js';
import type { Camelize } from '../../db/case-types.js';

export type { IdentityPhotoKind, IdentityPhotoStatus };

/** A current (not superseded) photo, as the services read it. */
export type IdentityPhotoRecord = Camelize<
  Pick<
    IdentityPhotos,
    'id' | 'user_id' | 'kind' | 'file_path' | 'status' | 'rejection_reason' | 'reviewed_at' | 'created_at'
  >
> & {
  /** Display name of the admin who decided, for the panel. Null while pending. */
  reviewedByName: string | null;
};

type Db = pg.Pool | pg.PoolClient;

const PHOTO_COLUMNS = `
  p.id, p.user_id AS "userId", p.kind::text AS kind, p.file_path AS "filePath",
  p.status::text AS status, p.rejection_reason AS "rejectionReason",
  p.reviewed_at AS "reviewedAt", p.created_at AS "createdAt",
  a.full_name AS "reviewedByName"`;

/** The only module that knows how identity photos are stored. */
export class IdentityRepository {
  constructor(private readonly db: pg.Pool) {}

  /** Current photos of a person, one per kind at most. */
  async currentPhotos(userId: string, db: Db = this.db): Promise<IdentityPhotoRecord[]> {
    const { rows } = await db.query<IdentityPhotoRecord>(
      `SELECT ${PHOTO_COLUMNS}
         FROM identity_photos p
         LEFT JOIN admins a ON a.id = p.reviewed_by
        WHERE p.user_id = $1 AND p.superseded_at IS NULL`,
      [userId],
    );
    return rows;
  }

  /**
   * The current photo of one kind, LOCKED for the rest of the transaction: two
   * uploads of the same kind racing each other must not both see "empty slot".
   */
  async lockCurrent(
    client: pg.PoolClient,
    userId: string,
    kind: IdentityPhotoKind,
  ): Promise<{ id: string; status: IdentityPhotoStatus } | null> {
    const { rows } = await client.query<{ id: string; status: IdentityPhotoStatus }>(
      `SELECT id, status::text AS status FROM identity_photos
        WHERE user_id = $1 AND kind = $2 AND superseded_at IS NULL
        FOR UPDATE`,
      [userId, kind],
    );
    return rows[0] ?? null;
  }

  /**
   * Locks every current photo of a person. Reviews take it first so two admins
   * deciding the last two photos at once cannot both miss the moment the
   * identity becomes complete (and both skip the "verified" notice).
   */
  async lockAllCurrent(client: pg.PoolClient, userId: string): Promise<void> {
    await client.query(
      `SELECT id FROM identity_photos WHERE user_id = $1 AND superseded_at IS NULL FOR UPDATE`,
      [userId],
    );
  }

  /** Read-only twin of `lockCurrent`, for the fast refusal before an upload. */
  async currentStatus(userId: string, kind: IdentityPhotoKind): Promise<IdentityPhotoStatus | null> {
    const { rows } = await this.db.query<{ status: IdentityPhotoStatus }>(
      `SELECT status::text AS status FROM identity_photos
        WHERE user_id = $1 AND kind = $2 AND superseded_at IS NULL`,
      [userId, kind],
    );
    return rows[0]?.status ?? null;
  }

  /** Retires the current photo of a kind (history is kept, never deleted). */
  async supersede(client: pg.PoolClient, photoId: string): Promise<void> {
    await client.query(`UPDATE identity_photos SET superseded_at = now() WHERE id = $1`, [photoId]);
  }

  async insert(
    client: pg.PoolClient,
    userId: string,
    kind: IdentityPhotoKind,
    filePath: string,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO identity_photos (user_id, kind, file_path) VALUES ($1, $2, $3) RETURNING id`,
      [userId, kind, filePath],
    );
    return rows[0]!.id;
  }

  /**
   * Points the person's profile photo at the selfie and returns the path it
   * held before, so the caller can decide whether that old object may go.
   */
  async setProfilePhoto(client: pg.PoolClient, userId: string, path: string): Promise<string | null> {
    const { rows } = await client.query<{ previous: string | null }>(
      `UPDATE users u SET photo_url = $2
         FROM (SELECT photo_url FROM users WHERE id = $1 FOR UPDATE) prev
        WHERE u.id = $1
        RETURNING prev.photo_url AS previous`,
      [userId, path],
    );
    return rows[0]?.previous ?? null;
  }

  async hasCurrentSelfie(userId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM identity_photos
        WHERE user_id = $1 AND kind = 'selfie' AND superseded_at IS NULL`,
      [userId],
    );
    return rows.length > 0;
  }

  async findPhoto(photoId: string): Promise<IdentityPhotoRecord & { supersededAt: Date | null } | null> {
    const { rows } = await this.db.query<IdentityPhotoRecord & { supersededAt: Date | null }>(
      `SELECT ${PHOTO_COLUMNS}, p.superseded_at AS "supersededAt"
         FROM identity_photos p
         LEFT JOIN admins a ON a.id = p.reviewed_by
        WHERE p.id = $1`,
      [photoId],
    );
    return rows[0] ?? null;
  }

  /**
   * Records the office's decision on a CURRENT photo. Returns false when the
   * photo was superseded in the meantime (the person retook it), so a stale
   * review never lands on a photo nobody is looking at any more.
   */
  async review(
    client: pg.PoolClient,
    photoId: string,
    status: 'approved' | 'rejected',
    reason: string | null,
    adminId: string,
  ): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE identity_photos
          SET status = $2, rejection_reason = $3, reviewed_by = $4, reviewed_at = now()
        WHERE id = $1 AND superseded_at IS NULL`,
      [photoId, status, reason, adminId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Takes an affiliate off duty. Used when one of his photos is rejected under
   * the identity rule: he cannot keep working on a revoked identity. A person
   * who is only a passenger has no `drivers` row and nothing happens.
   */
  async setUnavailable(client: pg.PoolClient, userId: string): Promise<void> {
    await client.query(
      `UPDATE drivers SET is_available = false WHERE user_id = $1 AND is_available`,
      [userId],
    );
  }

  /** The `identity_required_enabled` switch (Configuración). */
  async isRequired(db: Db = this.db): Promise<boolean> {
    const { rows } = await db.query<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'identity_required_enabled'`,
    );
    return rows[0]?.value === true;
  }

  async userExists(userId: string): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    return rows.length > 0;
  }
}
