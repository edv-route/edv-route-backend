import type pg from 'pg';

export interface AuditEntry {
  /** Omit (or null) for system-initiated events (scheduler jobs). */
  actorAdminId?: string | null;
  eventType: string;
  entity: string;
  entityId?: string | number | null;
  data?: unknown;
}

/**
 * Single write path to audit_logs, shared by every acting service and the
 * scheduler. Call it AFTER the business mutation succeeds - failed
 * operations must not leave audit entries.
 */
export async function writeAudit(db: pg.Pool, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_admin_id, event_type, entity, entity_id, data)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      entry.actorAdminId ?? null,
      entry.eventType,
      entry.entity,
      entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
      entry.data === undefined || entry.data === null ? null : JSON.stringify(entry.data),
    ],
  );
}
