import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { runApplicantCleanup } from '../src/plugins/applicant-cleanup-scheduler.js';
import { removeDriver } from './helpers/db-fixtures.js';

/**
 * The outbound cleanup purges abandoned registrations — and must never carry
 * money away with them (regla 7: an invoice is voided with a trace, never
 * deleted).
 *
 * The rule "pending, older than the grace period, with no live payment" used to
 * describe an alta nobody ever paid and that owed nothing. It stopped meaning
 * that: a panel registration WITHOUT payment, and an alta debt re-issued after a
 * reverted receipt, both leave a `pending` driver with emitted invoices and no
 * live submission. He owes money — purging him would delete his invoices and
 * wipe the debt (found in a dry-run log, 2026-08-19).
 *
 * These run in DRY-RUN (the switch is off by default), so nothing is deleted:
 * what is asserted is who the job SELECTS.
 */

let pool: pg.Pool;
/** Only `db` and `log` are touched while the cleanup is disabled. */
let app: FastifyInstance;

before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  app = { db: pool, log: { info: () => {}, error: () => {} } } as unknown as FastifyInstance;
});
after(async () => {
  await pool.end();
});

/** An abandoned `pending` registration, older than the 7-day grace period. */
async function makeStalePending(tag: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name)
     VALUES ('TEST', $1, $2) RETURNING id`,
    [tag, `TEST ${tag}`],
  );
  const driverId = rows[0]!.id;
  await pool.query(
    `INSERT INTO drivers (user_id, source, status, created_at)
     VALUES ($1, 'admin', 'pending', now() - interval '30 days')`,
    [driverId],
  );
  return driverId;
}

test('an abandoned pending registration with no invoices IS a purge candidate', async () => {
  const driverId = await makeStalePending('CleanupNoInvoice');
  try {
    const result = await runApplicantCleanup(app);
    assert.equal(result.dryRun, true, 'la prueba exige el limpiador APAGADO (dry-run)');
    assert.ok(
      result.candidates.includes(driverId),
      'un registro abandonado sin facturas debería ser candidato',
    );
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('the same registration is SPARED once it owes an invoice', async () => {
  const driverId = await makeStalePending('CleanupWithInvoice');
  try {
    await pool.query(
      `INSERT INTO invoices (driver_id, total_usd, status)
       VALUES ($1, '190.00', 'issued')`,
      [driverId],
    );
    const result = await runApplicantCleanup(app);
    assert.ok(
      !result.candidates.includes(driverId),
      'un afiliado con factura emitida NUNCA debe entrar a la purga: se le borraría la deuda',
    );
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('a VOIDED invoice also spares him (a money document is kept, not deleted)', async () => {
  const driverId = await makeStalePending('CleanupVoidedInvoice');
  try {
    await pool.query(
      `INSERT INTO invoices (driver_id, total_usd, status)
       VALUES ($1, '180.00', 'voided')`,
      [driverId],
    );
    const result = await runApplicantCleanup(app);
    assert.ok(
      !result.candidates.includes(driverId),
      'una factura anulada sigue siendo un documento que se conserva',
    );
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('a person who is ALSO a client is never a purge candidate (roles independientes)', async () => {
  const driverId = await makeStalePending('CleanupCliente');
  try {
    // The same human has a passenger life: purging the solicitud would delete
    // the whole users row in cascade and take his client account with it.
    await pool.query(
      `INSERT INTO clients (user_id, status, accepted_privacy_at) VALUES ($1, 'active', now())`,
      [driverId],
    );
    const result = await runApplicantCleanup(app);
    assert.ok(
      !result.candidates.includes(driverId),
      'una solicitud abandonada de alguien que es cliente NO se purga: se llevaría su vida de pasajero',
    );
  } finally {
    await pool.query('DELETE FROM clients WHERE user_id = $1', [driverId]).catch(() => {});
    await removeDriver(pool, driverId);
  }
});
