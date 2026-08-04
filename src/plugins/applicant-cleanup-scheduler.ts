import fp from 'fastify-plugin';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../modules/audit-logs/audit-writer.js';

// Registration is OPEN by design; the quality gate is the admin's approval, not
// the entry. This job is the OUTBOUND cleanup: applicants that never finished
// (no live payment) or were rejected are purged after a grace period, so the
// review inbox and the storage bucket don't fill with junk. OFF by default:
// while `applicant_cleanup_enabled` is false it only reports (dry-run).
const TICK_MS = 60 * 60 * 1000; // hourly; the 7-day window makes the exact cadence irrelevant
const GRACE_DAYS = 7;

export interface ApplicantCleanupResult {
  enabled: boolean;
  dryRun: boolean;
  /** Driver ids purged (or, in dry-run, that WOULD be purged). */
  candidates: string[];
}

async function cleanupEnabled(db: pg.Pool): Promise<boolean> {
  const { rows } = await db.query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE key = 'applicant_cleanup_enabled'`,
  );
  return rows[0]?.value === true;
}

/**
 * Applicants eligible for purge (decision 2026-08-04):
 *  - `pending` WITHOUT a live (pending/approved) payment submission, older than
 *    the grace period. "No live payment" = never finished step 4, OR the payment
 *    was rejected and never retried. A completed applicant awaiting review keeps
 *    a `pending` submission, so he is NOT selected (kept until approved/rejected).
 *  - `rejected` past the grace period (measured from the last status change).
 * `registration_step` is deliberately NOT used: the transactional register leaves
 * it null (=done) even before the files/payment arrive, so it cannot tell apart
 * an abandoned alta from a completed one.
 */
async function findExpiredApplicants(db: pg.Pool): Promise<string[]> {
  const { rows } = await db.query<{ userId: string }>(
    `SELECT d.user_id AS "userId"
       FROM drivers d
      WHERE (d.status = 'pending'
             AND d.created_at < now() - make_interval(days => $1)
             AND NOT EXISTS (
               SELECT 1 FROM payment_submissions ps
                WHERE ps.driver_id = d.user_id
                  AND ps.status IN ('pending', 'approved')))
         OR (d.status = 'rejected'
             AND d.updated_at < now() - make_interval(days => $1))`,
    [GRACE_DAYS],
  );
  return rows.map((r) => r.userId);
}

/** Every storage key owned by the driver: document files, vehicle photos, receipts. */
async function driverStoragePaths(db: pg.Pool, driverId: string): Promise<string[]> {
  const { rows } = await db.query<{ path: string }>(
    `SELECT file_url AS path FROM documents
      WHERE file_url IS NOT NULL
        AND (driver_id = $1 OR vehicle_id IN (SELECT id FROM vehicles WHERE driver_id = $1))
     UNION ALL
     SELECT file_url AS path FROM vehicle_images
      WHERE vehicle_id IN (SELECT id FROM vehicles WHERE driver_id = $1)
     UNION ALL
     SELECT storage_path AS path FROM payment_submission_files
      WHERE submission_id IN (SELECT id FROM payment_submissions WHERE driver_id = $1)`,
    [driverId],
  );
  return rows.map((r) => r.path);
}

/**
 * Deletes the driver and everything under it in one transaction (rows only).
 * Money tables are RESTRICT so they go first; deleting the user cascades to
 * drivers -> vehicles -> vehicle_images and documents. The FOR UPDATE on the
 * subscriptions blocks a concurrent scheduler from inserting a charge mid-delete.
 */
async function deleteDriverCascade(db: pg.Pool, driverId: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM driver_subscriptions WHERE driver_id = $1 FOR UPDATE`, [driverId]);
    await client.query(`DELETE FROM payment_submissions WHERE driver_id = $1`, [driverId]);
    await client.query(
      `DELETE FROM subscription_payments WHERE driver_subscription_id IN
         (SELECT id FROM driver_subscriptions WHERE driver_id = $1)`,
      [driverId],
    );
    await client.query(`DELETE FROM membership_payments WHERE driver_id = $1`, [driverId]);
    await client.query(`DELETE FROM invoices WHERE driver_id = $1`, [driverId]);
    await client.query(`DELETE FROM driver_subscriptions WHERE driver_id = $1`, [driverId]);
    await client.query(`DELETE FROM users WHERE id = $1`, [driverId]); // cascades to drivers
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * One cleanup pass. Exported so a test can drive it directly. While disabled
 * (the default) it only logs what it WOULD purge; nothing is deleted.
 */
export async function runApplicantCleanup(app: FastifyInstance): Promise<ApplicantCleanupResult> {
  const enabled = await cleanupEnabled(app.db);
  const candidates = await findExpiredApplicants(app.db);
  if (candidates.length === 0) return { enabled, dryRun: !enabled, candidates: [] };

  if (!enabled) {
    app.log.info(
      { count: candidates.length, drivers: candidates },
      'applicant-cleanup DRY-RUN: would purge expired applicants (enable applicant_cleanup_enabled to purge)',
    );
    return { enabled, dryRun: true, candidates };
  }

  const purged: string[] = [];
  for (const driverId of candidates) {
    // Collect storage keys BEFORE the rows vanish.
    const paths = await driverStoragePaths(app.db, driverId);
    try {
      await deleteDriverCascade(app.db, driverId);
    } catch (err) {
      app.log.error({ err, driverId }, 'applicant-cleanup: failed to purge driver, skipping');
      continue;
    }
    // Rows are gone; drop the files best-effort (orphaned files are harmless).
    if (app.storage) {
      for (const path of paths) {
        await app.storage
          .remove(path)
          .catch((err: unknown) => app.log.warn({ err, path }, 'applicant-cleanup: file remove failed'));
      }
    }
    await writeAudit(app.db, {
      eventType: 'applicant.purged',
      entity: 'drivers',
      entityId: driverId,
      data: { files: paths.length },
    });
    purged.push(driverId);
  }
  app.log.info({ count: purged.length }, 'applicant-cleanup: purged expired applicants');
  return { enabled, dryRun: false, candidates: purged };
}

/**
 * Applicant cleanup job: hourly + on boot, same shape as the other schedulers.
 * OFF by default (dry-run), so registering it never deletes anything by itself.
 */
export default fp(
  async (app) => {
    let running = false;
    const tick = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        await runApplicantCleanup(app);
      } catch (err) {
        app.log.error(err, 'applicant-cleanup tick failed');
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void tick(), TICK_MS);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
    void tick(); // catch up on boot
  },
  { name: 'applicant-cleanup-scheduler', dependencies: ['db'] },
);
