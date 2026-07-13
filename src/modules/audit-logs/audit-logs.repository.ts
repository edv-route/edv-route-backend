import type pg from 'pg';
import type AuditLogs from '../../db/models/public/AuditLogs.js';
import type { Camelize } from '../../db/case-types.js';

type AuditLogRow = Camelize<AuditLogs>;

/** List projection - raw log row plus resolved actor and affected driver. */
export type AuditLogItem = Pick<
  AuditLogRow,
  'id' | 'eventType' | 'entity' | 'entityId' | 'data' | 'createdAt'
> & {
  actorType: 'admin' | 'user' | 'system';
  actorName: string | null;
  actorUsername: string | null;
  driverId: string | null;
  driverName: string | null;
};

export interface AuditLogListResult {
  items: AuditLogItem[];
  total: number;
}

export interface AuditLogFacets {
  eventTypes: string[];
  entities: string[];
  actors: { id: string; fullName: string; username: string }[];
}

export interface AuditLogListFilters {
  entity?: string;
  eventType?: string;
  source?: 'admin' | 'system';
  adminId?: string;
  /** Calendar day (YYYY-MM-DD) interpreted in the business timezone. */
  from?: string;
  to?: string;
  page: number;
  limit: number;
  timezone: string;
}

/**
 * Resolves the driver a log entry refers to. entity_id is text by design
 * (logs may point at any table); for the entities below it always holds a
 * uuid written by our own backend, so the cast is safe.
 */
const DRIVER_REF = `(CASE
  WHEN al.entity = 'drivers' THEN al.entity_id
  WHEN al.entity = 'driver_subscriptions' THEN al.data->>'driverId'
END)::uuid`;

export class AuditLogsRepository {
  constructor(private readonly db: pg.Pool) {}

  async list(opts: AuditLogListFilters): Promise<AuditLogListResult> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (opts.entity) {
      values.push(opts.entity);
      where.push(`al.entity = $${values.length}`);
    }
    if (opts.eventType) {
      values.push(opts.eventType);
      where.push(`al.event_type = $${values.length}`);
    }
    if (opts.source === 'admin') {
      where.push('al.actor_admin_id IS NOT NULL');
    } else if (opts.source === 'system') {
      where.push('al.actor_admin_id IS NULL AND al.actor_user_id IS NULL');
    }
    if (opts.adminId) {
      values.push(opts.adminId);
      where.push(`al.actor_admin_id = $${values.length}`);
    }
    // Day boundaries at local midnight (business timezone), kept sargable
    // so the created_at index stays usable.
    if (opts.from) {
      values.push(opts.from, opts.timezone);
      where.push(`al.created_at >= (($${values.length - 1}::date)::timestamp AT TIME ZONE $${values.length})`);
    }
    if (opts.to) {
      values.push(opts.to, opts.timezone);
      where.push(`al.created_at < (($${values.length - 1}::date + 1)::timestamp AT TIME ZONE $${values.length})`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_logs al ${whereSql}`,
      values,
    );

    values.push(opts.limit, (opts.page - 1) * opts.limit);
    const { rows } = await this.db.query<AuditLogItem>(
      `SELECT al.id, al.event_type AS "eventType", al.entity, al.entity_id AS "entityId",
              al.data, al.created_at AS "createdAt",
              CASE WHEN al.actor_admin_id IS NOT NULL THEN 'admin'
                   WHEN al.actor_user_id IS NOT NULL THEN 'user'
                   ELSE 'system' END AS "actorType",
              adm.full_name AS "actorName", adm.username AS "actorUsername",
              du.id AS "driverId", du.full_name AS "driverName"
       FROM audit_logs al
       LEFT JOIN admins adm ON adm.id = al.actor_admin_id
       LEFT JOIN users du ON du.id = ${DRIVER_REF}
       ${whereSql}
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    return { items: rows, total: Number(countResult.rows[0]!.count) };
  }

  /** Distinct values actually present in the log - drives the UI filters. */
  async facets(): Promise<AuditLogFacets> {
    const { rows } = await this.db.query<AuditLogFacets>(
      `SELECT
         (SELECT COALESCE(json_agg(DISTINCT event_type), '[]'::json)
          FROM audit_logs) AS "eventTypes",
         (SELECT COALESCE(json_agg(DISTINCT entity), '[]'::json)
          FROM audit_logs) AS "entities",
         (SELECT COALESCE(json_agg(json_build_object(
            'id', a.id, 'fullName', a.full_name, 'username', a.username)
            ORDER BY a.full_name), '[]'::json)
          FROM admins a
          WHERE EXISTS (SELECT 1 FROM audit_logs al WHERE al.actor_admin_id = a.id)) AS actors`,
    );
    return rows[0]!;
  }
}
