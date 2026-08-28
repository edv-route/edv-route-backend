import fp from 'fastify-plugin';
import { writeAudit } from '../modules/audit-logs/audit-writer.js';
import { EnrollmentRepository } from '../modules/drivers/enrollment.repository.js';

const TICK_MS = 60_000;

/**
 * Scheduled-driver activation (2026-08-09). Replaces the old auto-approval job:
 * approval is now ALWAYS a manual admin choice. When the admin approves with the
 * "próximo lunes" option the driver is left `scheduled` (programado) and his
 * subscription is anchored to that Monday. This job flips him to operative the
 * moment that Monday arrives — driver → `approved` + available, subscription →
 * `active` — so a full week starts cleanly with no further manual step. Idempotent
 * and independent of the debt engine (a scheduled driver must still activate even
 * if the engine is later turned off).
 */
export default fp(
  async (app) => {
    // Producción y desarrollo comparten UNA base de datos: un backend local
    // que programe este timer escribe sobre datos reales. Misma guarda que el
    // despachador de avisos y la purga de ubicación.
    if (app.config.NODE_ENV !== 'production') {
      app.log.info('scheduled-driver-activation: no programado (solo corre en producción · activaciones programadas)');
      return;
    }

    const enrollment = new EnrollmentRepository(app.db);
    let running = false;

    const tick = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        // `scheduled` drivers whose start Monday has begun (their subscription's
        // coverage window opened). timestamptz comparison — no timezone needed.
        const { rows } = await app.db.query<{ driverId: string }>(
          `SELECT d.user_id AS "driverId"
           FROM drivers d
           JOIN driver_subscriptions ds
             ON ds.driver_id = d.user_id AND ds.status = 'scheduled'
           WHERE d.status::text = 'scheduled'
             AND ds.current_period_start <= now()`,
        );
        for (const { driverId } of rows) {
          try {
            await enrollment.activateScheduled(driverId);
            await writeAudit(app.db, {
              eventType: 'driver.activated',
              entity: 'drivers',
              entityId: driverId,
              data: { driverId, auto: true },
            });
            app.log.info({ driverId }, 'scheduled driver activated (Monday reached)');
          } catch (err) {
            app.log.error({ err, driverId }, 'scheduled driver activation failed');
          }
        }
      } catch (err) {
        app.log.error(err, 'scheduled-activation scheduler tick failed');
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), TICK_MS);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));

    void tick(); // catch up on boot (covers a Monday the server was down for)
  },
  { name: 'scheduled-driver-activation', dependencies: ['db'] },
);
