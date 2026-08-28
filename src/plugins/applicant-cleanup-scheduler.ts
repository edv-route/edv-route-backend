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
 * Applicants eligible for purge (decision 2026-08-04, extended for solicitudes-app
 * 2026-08-13):
 *  - `pending` WITHOUT a live (pending/approved) payment submission, older than
 *    the grace period. "No live payment" = never finished step 4, OR the payment
 *    was rejected and never retried. A completed applicant awaiting review keeps
 *    a `pending` submission, so he is NOT selected (kept until approved/rejected).
 *  - `applicant` (app registration born `applicant`) that stayed EMPTY — no
 *    documents and no vehicles — past the grace period: a step-1-only registration
 *    that was abandoned. An applicant who uploaded anything is "in progress" and
 *    is left for the admin to approve/reject (not purged by time).
 * `rejected` records are NOT purged (policy 2026-08-13): a rejected solicitud is
 * kept on file so its cédula stays blocked from self-service re-registration; the
 * applicant must contact an admin, who may reopen it. `registration_step` is
 * deliberately NOT used: the transactional register leaves it null (=done) even
 * before the files/payment arrive, so it cannot tell an abandoned alta from a
 * completed one.
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
                  AND ps.status IN ('pending', 'approved'))
             -- Never a driver with invoices (regla 7: money documents are voided
             -- with a trace, never deleted). "No live payment" used to mean an
             -- abandoned alta owing nothing; since a panel registration without
             -- payment — and a re-issued alta debt after a reverted receipt — it
             -- can also mean someone who OWES and has not paid yet. Purging him
             -- would delete emitted invoices and wipe the debt.
             AND NOT EXISTS (
               SELECT 1 FROM invoices i WHERE i.driver_id = d.user_id))
         OR (d.status = 'applicant'
             AND d.created_at < now() - make_interval(days => $1)
             AND NOT EXISTS (SELECT 1 FROM documents doc WHERE doc.driver_id = d.user_id)
             AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.driver_id = d.user_id))`,
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
    // Last line of defence, INSIDE the transaction: whatever the selection rule
    // says today or after some future edit, this delete refuses to carry money
    // away. An invoice — even a voided one — is a document that is kept, so its
    // mere existence disqualifies the driver from being purged.
    const { rows: money } = await client.query<{ invoices: string }>(
      `SELECT count(*)::text AS invoices FROM invoices WHERE driver_id = $1`,
      [driverId],
    );
    if (money[0] && money[0].invoices !== '0') {
      throw new Error(
        `applicant-cleanup refused to purge ${driverId}: has ${money[0].invoices} invoice(s)`,
      );
    }
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
    // Producción y desarrollo comparten UNA base de datos: un backend local
    // que programe este timer escribe sobre datos reales. Misma guarda que el
    // despachador de avisos y la purga de ubicación.
    if (app.config.NODE_ENV !== 'production') {
      app.log.info('applicant-cleanup-scheduler: no programado (solo corre en producción · limpieza de solicitantes)');
      return;
    }

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
