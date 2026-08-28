import fp from 'fastify-plugin';
import { writeAudit } from '../modules/audit-logs/audit-writer.js';

const TICK_MS = 60_000;

/**
 * Document expiry job: marks `valid` documents as `expired` once their
 * expiry date has passed (midnight in the business timezone, same principle
 * as tariff periods). Expired documents alert the panel but do NOT block
 * the driver's operation - blocking would be a new business rule.
 * Every transition is audited with the system actor. Idempotent and cheap:
 * runs every minute and on boot (same cadence as the tariff scheduler).
 */
export default fp(
  async (app) => {
    // Producción y desarrollo comparten UNA base de datos: un backend local
    // que programe este timer escribe sobre datos reales. Misma guarda que el
    // despachador de avisos y la purga de ubicación.
    if (app.config.NODE_ENV !== 'production') {
      app.log.info('document-scheduler: no programado (solo corre en producción · vencimiento de documentos)');
      return;
    }

    let running = false;

    const tick = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        const { rows: settingRows } = await app.db.query<{ value: unknown }>(
          `SELECT value FROM app_settings WHERE key = 'business_timezone'`,
        );
        const timezone = String(settingRows[0]?.value ?? 'America/Caracas');

        const { rows: expired } = await app.db.query<{
          id: string;
          requirementId: number;
          driverId: string;
        }>(
          `WITH exp AS (
             UPDATE documents SET status = 'expired'
             WHERE status = 'valid'
               AND expires_at IS NOT NULL
               AND expires_at < (now() AT TIME ZONE $1)::date
             RETURNING id, requirement_id, driver_id, vehicle_id
           )
           SELECT e.id, e.requirement_id AS "requirementId",
                  COALESCE(e.driver_id, v.driver_id) AS "driverId"
           FROM exp e
           LEFT JOIN vehicles v ON v.id = e.vehicle_id`,
          [timezone],
        );

        for (const row of expired) {
          await writeAudit(app.db, {
            eventType: 'document.expired',
            entity: 'documents',
            entityId: row.id,
            data: { driverId: row.driverId, requirementId: row.requirementId },
          });
          app.log.info({ documentId: row.id, driverId: row.driverId }, 'document expired (auto)');
        }
      } catch (err) {
        app.log.error(err, 'document scheduler tick failed');
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), TICK_MS);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));

    void tick(); // catch up on boot (covers server downtime)
  },
  { name: 'document-scheduler', dependencies: ['db'] },
);
