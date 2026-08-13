import type pg from 'pg';
import type Documents from '../../db/models/public/Documents.js';
import type { Camelize } from '../../db/case-types.js';

type DocumentRow = Camelize<Documents>;

/** Cross-cutting projection: every document resolves to its owning driver. */
export type DocumentListItem = Pick<
  DocumentRow,
  'id' | 'requirementId' | 'fileUrl' | 'expiresAt' | 'status' | 'createdAt'
> & {
  requirementName: string;
  appliesTo: 'driver' | 'vehicle';
  driverId: string;
  driverName: string;
  vehicleId: string | null;
  vehiclePlate: string | null;
};

export interface DocumentListResult {
  items: DocumentListItem[];
  total: number;
}

export interface DocumentListFilters {
  status?: string;
  requirementId?: number;
  search?: string;
  /** Only valid docs whose expiry falls within N days (business timezone). */
  expiringDays?: number;
  page: number;
  limit: number;
  timezone: string;
}

/** documents_check guarantees exactly one owner: driver_id XOR vehicle_id. */
const FROM_SQL = `
  FROM documents doc
  JOIN requirements r ON r.id = doc.requirement_id
  LEFT JOIN vehicles v ON v.id = doc.vehicle_id
  JOIN users u ON u.id = COALESCE(doc.driver_id, v.driver_id)
`;

export class DocumentsRepository {
  constructor(private readonly db: pg.Pool) {}

  /** Owner resolution for file operations (drivers own vehicles' documents). */
  async findOwner(
    id: string,
  ): Promise<{ id: string; driverId: string; fileUrl: string | null } | null> {
    const { rows } = await this.db.query<{ id: string; driverId: string; fileUrl: string | null }>(
      `SELECT doc.id, COALESCE(doc.driver_id, v.driver_id) AS "driverId",
              doc.file_url AS "fileUrl"
       FROM documents doc
       LEFT JOIN vehicles v ON v.id = doc.vehicle_id
       WHERE doc.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Links (or replaces) the stored file. `resetApproval` re-opens the review:
   * replacing the file invalidates any prior verdict, so an approved/rejected
   * document goes back to `pending` (and its rejection reason/reviewer clear).
   * Used for the app/driver channel — the anti-fraud gate of solicitudes-app,
   * where an applicant must not be able to swap an approved file for another.
   */
  async setFileUrl(id: string, fileUrl: string, resetApproval = false): Promise<void> {
    if (resetApproval) {
      await this.db.query(
        `UPDATE documents
            SET file_url = $2, approval_status = 'pending',
                rejection_reason = NULL, reviewed_by = NULL, reviewed_at = NULL
          WHERE id = $1`,
        [id, fileUrl],
      );
      return;
    }
    await this.db.query('UPDATE documents SET file_url = $2 WHERE id = $1', [id, fileUrl]);
  }

  /**
   * Records the admin's review verdict (approve/reject). `rejectionReason` is
   * shown to the applicant so he can fix and resubmit; it's cleared on approval.
   */
  async review(
    id: string,
    approvalStatus: 'approved' | 'rejected',
    rejectionReason: string | null,
    reviewedBy: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE documents
          SET approval_status = $2, rejection_reason = $3, reviewed_by = $4, reviewed_at = now()
        WHERE id = $1`,
      [id, approvalStatus, rejectionReason, reviewedBy],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.query('DELETE FROM documents WHERE id = $1', [id]);
  }

  async list(opts: DocumentListFilters): Promise<DocumentListResult> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (opts.status) {
      values.push(opts.status);
      where.push(`doc.status = $${values.length}`);
    }
    if (opts.requirementId) {
      values.push(opts.requirementId);
      where.push(`doc.requirement_id = $${values.length}`);
    }
    if (opts.search) {
      values.push(`%${opts.search}%`);
      where.push(`(u.full_name ILIKE $${values.length} OR v.plate ILIKE $${values.length})`);
    }
    if (opts.expiringDays !== undefined) {
      values.push(opts.timezone, opts.expiringDays);
      where.push(
        `doc.status = 'valid' AND doc.expires_at IS NOT NULL
         AND doc.expires_at <= (now() AT TIME ZONE $${values.length - 1})::date + ($${values.length})::int`,
      );
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count ${FROM_SQL} ${whereSql}`,
      values,
    );

    values.push(opts.limit, (opts.page - 1) * opts.limit);
    const { rows } = await this.db.query<DocumentListItem>(
      `SELECT doc.id, doc.requirement_id AS "requirementId", r.name AS "requirementName",
              r.applies_to AS "appliesTo", doc.file_url AS "fileUrl",
              doc.expires_at AS "expiresAt", doc.status, doc.created_at AS "createdAt",
              COALESCE(doc.driver_id, v.driver_id) AS "driverId", u.full_name AS "driverName",
              doc.vehicle_id AS "vehicleId", v.plate AS "vehiclePlate"
       ${FROM_SQL}
       ${whereSql}
       ORDER BY doc.expires_at ASC NULLS LAST, doc.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    return { items: rows, total: Number(countResult.rows[0]!.count) };
  }
}
