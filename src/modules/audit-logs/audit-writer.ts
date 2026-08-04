import type pg from 'pg';

export interface AuditEntry {
  /** Admin actor (panel). Omit (or null) for system/app-initiated events. */
  actorAdminId?: string | null;
  /**
   * Driver/user actor (mobile app). Set for `source='app'` events (e.g. a
   * self-service registration or payment submission) where there is no admin.
   * Both actor columns null = system-initiated (scheduler jobs).
   */
  actorUserId?: string | null;
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
    `INSERT INTO audit_logs (actor_admin_id, actor_user_id, event_type, entity, entity_id, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.actorAdminId ?? null,
      entry.actorUserId ?? null,
      entry.eventType,
      entry.entity,
      entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
      entry.data === undefined || entry.data === null ? null : JSON.stringify(entry.data),
    ],
  );
}
