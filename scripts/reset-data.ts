import 'dotenv/config';
import pg from 'pg';

/**
 * FULL reset of test data for the billing redesign (2026-08-04). Wipes every
 * driver and all of their money / vehicle / document / audit data, and RESTARTS
 * invoice + receipt numbering. Keeps the CATALOGS untouched: memberships,
 * membership_benefits, benefits, subscription_plans, requirements,
 * payment_methods, vehicle_types, app_settings, trainings, admins.
 *
 * DESTRUCTIVE — run ONLY against the development database:
 *   node --import tsx scripts/reset-data.ts
 */

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

// User/driver-scoped tables. CASCADE covers anything else that references them;
// listing them keeps the intent explicit. Catalogs and admins are NOT here.
const TABLES = [
  'payment_submission_files',
  'payment_submissions',
  'subscription_payments',
  'membership_payments',
  'invoices',
  'driver_subscriptions',
  'documents',
  'vehicle_images',
  'vehicles',
  'training_attendees',
  'audit_logs',
  'drivers',
  'users',
];

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    // Named sequences (not owned by a serial column) must be reset explicitly.
    await client.query('ALTER SEQUENCE invoice_number_seq RESTART WITH 1');
    await client.query('ALTER SEQUENCE payment_submission_number_seq RESTART WITH 1');
    await client.query('COMMIT');
    console.log('✅ Datos de prueba borrados (choferes, pagos, facturas, recibos, vehículos, documentos).');
    console.log('   Catálogos y administradores intactos · numeración de facturas y recibos reiniciada en 1.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ Reset falló:', err);
  process.exitCode = 1;
});
