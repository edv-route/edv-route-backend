import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { LocationsRepository } from '../modules/locations/locations.repository.js';
import { LocationsService } from '../modules/locations/locations.service.js';

/**
 * Drops location history past its retention window (proposal:
 * docs/proposals/ubicacion-afiliados).
 *
 * This is not housekeeping bolted on afterwards — it is what keeps a table that
 * only ever grows from eating a 500 MB database. It ships with the table on
 * purpose, before there is anything to delete.
 *
 * The window is read from `app_settings` on EVERY pass, so changing the number
 * in the panel takes effect without a redeploy — same as the debt engine reads
 * its own settings each tick.
 */

// Hourly. The window is measured in days, so the exact cadence is irrelevant;
// hourly just means a restart never leaves a long gap.
const TICK_MS = 60 * 60 * 1000;

export interface LocationPurgeResult {
  /** False outside production: nothing was deleted. */
  ran: boolean;
  retentionDays: number;
  deleted: number;
}

/** One pass. Exported so it can be driven directly instead of waiting an hour. */
export async function runLocationPurge(app: FastifyInstance): Promise<LocationPurgeResult> {
  const service = new LocationsService(app, new LocationsRepository(app.db));
  const retentionDays = await service.retentionDays();

  // ⚠️ Production and development share ONE database. Without this, running the
  // backend locally would delete production's location history — the same
  // reasoning that keeps the notification dispatcher out of local machines.
  if (app.config.NODE_ENV !== 'production') {
    return { ran: false, retentionDays, deleted: 0 };
  }

  const deleted = await new LocationsRepository(app.db).purgeOlderThan(retentionDays);
  if (deleted > 0) {
    app.log.info({ deleted, retentionDays }, 'location-retention: historial purgado');
  }
  return { ran: true, retentionDays, deleted };
}

export default fp(
  async (app) => {
    // Same guard as the dispatcher: a local backend does not even schedule the
    // timer, so it cannot delete shared data even by accident.
    if (app.config.NODE_ENV !== 'production') {
      app.log.info('location-retention: no programado (solo corre en producción)');
      return;
    }

    let running = false;
    const tick = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        await runLocationPurge(app);
      } catch (err) {
        app.log.error(err, 'location-retention tick failed');
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), TICK_MS);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
    void tick(); // catch up on boot
    app.log.info('location-retention started');
  },
  { name: 'location-retention', dependencies: ['db'] },
);
