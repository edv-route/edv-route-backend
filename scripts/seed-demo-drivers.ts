import 'dotenv/config';
import pg from 'pg';

/**
 * Cleans up test/demo leftovers and seeds a few DEMO drivers to exercise the
 * option-A flows in the panel, one per DERIVED invoice state (Fase 3):
 * SinPago = Emitida (pure debt) · AlDia = Pagada · PagoParcial = Emitida with a
 * paid charge · Anulada = Anulada. Identifiable by the "DEMO " / "TEST " name
 * prefix, so re-running is idempotent and cleanup is trivial. Run:
 *   node --import tsx scripts/seed-demo-drivers.ts
 *   node --import tsx scripts/seed-demo-drivers.ts --clean   # only delete, no seed
 */

const CLEAN_ONLY = process.argv.includes('--clean');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const TZ = 'America/Caracas';
/** Monday 00:00 of the running week (business timezone) — a week already in force. */
const THIS_MONDAY = `(date_trunc('week', (now() AT TIME ZONE '${TZ}')) AT TIME ZONE '${TZ}')`;
/** The Monday an alta paid today buys: the next one, unless today IS Monday. */
const ALTA_MONDAY = `((CASE WHEN extract(isodow FROM (now() AT TIME ZONE '${TZ}')) = 1
       THEN date_trunc('week', (now() AT TIME ZONE '${TZ}'))
       ELSE date_trunc('week', (now() AT TIME ZONE '${TZ}')) + interval '7 days'
  END) AT TIME ZONE '${TZ}')`;

async function purge(): Promise<void> {
  await pool.query(
    `DELETE FROM subscription_payments WHERE driver_subscription_id IN
       (SELECT ds.id FROM driver_subscriptions ds JOIN users u ON u.id = ds.driver_id
        WHERE u.full_name LIKE 'TEST %' OR u.full_name LIKE 'DEMO %')`,
  );
  await pool.query(
    `DELETE FROM membership_payments WHERE driver_id IN
       (SELECT id FROM users WHERE full_name LIKE 'TEST %' OR full_name LIKE 'DEMO %')`,
  );
  await pool.query(
    `DELETE FROM invoices WHERE driver_id IN
       (SELECT id FROM users WHERE full_name LIKE 'TEST %' OR full_name LIKE 'DEMO %')`,
  );
  await pool.query(
    `DELETE FROM driver_subscriptions WHERE driver_id IN
       (SELECT id FROM users WHERE full_name LIKE 'TEST %' OR full_name LIKE 'DEMO %')`,
  );
  await pool.query(`DELETE FROM users WHERE full_name LIKE 'TEST %' OR full_name LIKE 'DEMO %'`);
}

async function makeUser(first: string, last: string, status: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name) VALUES ($1, $2, $3) RETURNING id`,
    [first, last, `${first} ${last}`],
  );
  const userId = rows[0]!.id;
  await pool.query(`INSERT INTO drivers (user_id, source, status) VALUES ($1, 'admin', $2)`, [userId, status]);
  return userId;
}

async function main(): Promise<void> {
  try {
    console.log('\n== Limpieza de TEST/DEMO ==');
    await purge();
    console.log('   residuos eliminados.');
    if (CLEAN_ONLY) {
      console.log('\n--clean: no se sembró nada.\n');
      return;
    }

    const { rows: m } = await pool.query<{ id: number; price: string }>(
      `SELECT id, price_usd AS price FROM memberships WHERE active LIMIT 1`,
    );
    const { rows: p } = await pool.query<{ id: number; price: string }>(
      `SELECT id, price_usd AS price FROM subscription_plans
       WHERE active AND billing_period = 'weekly' ORDER BY id LIMIT 1`,
    );
    if (!m[0] || !p[0]) {
      console.error('\n❌ Falta una membresía activa o una tarifa semanal activa. No se puede sembrar.\n');
      process.exitCode = 1;
      return;
    }
    const membership = m[0];
    const plan = p[0];

    console.log('\n== Sembrando DEMO ==');

    // A) Registration WITHOUT payment: alta debt (membership + 1 week), pending.
    {
      const driverId = await makeUser('DEMO', 'SinPago', 'pending');
      const total = Number(membership.price) + Number(plan.price);
      const { rows: inv } = await pool.query<{ id: string }>(
        `INSERT INTO invoices (driver_id, total_usd) VALUES ($1, $2) RETURNING id`,
        [driverId, total],
      );
      const invoiceId = inv[0]!.id;
      await pool.query(
        `INSERT INTO membership_payments (driver_id, membership_id, invoice_id, amount_usd, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [driverId, membership.id, invoiceId, membership.price],
      );
      const { rows: sub } = await pool.query<{ id: string }>(
        `INSERT INTO driver_subscriptions (driver_id, plan_id, status) VALUES ($1, $2, 'scheduled') RETURNING id`,
        [driverId, plan.id],
      );
      await pool.query(
        `INSERT INTO subscription_payments
           (driver_subscription_id, invoice_id, period_start, period_end, amount_usd, status)
         VALUES ($1, $2, ${ALTA_MONDAY}, ${ALTA_MONDAY} + interval '7 days', $3, 'pending')`,
        [sub[0]!.id, invoiceId, plan.price],
      );
      console.log(`   DEMO SinPago (pendiente, deuda $${total.toFixed(2)} = membresía + 1 semana).`);
    }

    // B) Up to date: approved, membership paid, one paid week of live coverage.
    {
      const driverId = await makeUser('DEMO', 'AlDia', 'approved');
      const total = Number(membership.price) + Number(plan.price);
      const { rows: inv } = await pool.query<{ id: string }>(
        `INSERT INTO invoices (driver_id, total_usd) VALUES ($1, $2) RETURNING id`,
        [driverId, total],
      );
      const invoiceId = inv[0]!.id;
      await pool.query(
        `INSERT INTO membership_payments (driver_id, membership_id, invoice_id, amount_usd, status, paid_at)
         VALUES ($1, $2, $3, $4, 'paid', now())`,
        [driverId, membership.id, invoiceId, membership.price],
      );
      // Already operating: his week is the calendar week in force (Monday-anchored).
      const { rows: sub } = await pool.query<{ id: string }>(
        `INSERT INTO driver_subscriptions (driver_id, plan_id, status, started_at, current_period_start, current_period_end)
         VALUES ($1, $2, 'active', now(), ${THIS_MONDAY}, ${THIS_MONDAY} + interval '7 days') RETURNING id`,
        [driverId, plan.id],
      );
      await pool.query(
        `INSERT INTO subscription_payments
           (driver_subscription_id, invoice_id, period_start, period_end, amount_usd, status, paid_at)
         VALUES ($1, $2, ${THIS_MONDAY}, ${THIS_MONDAY} + interval '7 days', $3, 'paid', now())`,
        [sub[0]!.id, invoiceId, plan.price],
      );
      console.log('   DEMO AlDia (aprobado, semana en curso pagada, lunes a lunes).');
    }

    // C) PARTIALLY settled invoice: membership paid, first week still owed.
    //    The derived state must stay "Emitida" (a half-paid invoice is not paid).
    {
      const driverId = await makeUser('DEMO', 'PagoParcial', 'pending');
      const total = Number(membership.price) + Number(plan.price);
      const { rows: inv } = await pool.query<{ id: string }>(
        `INSERT INTO invoices (driver_id, total_usd) VALUES ($1, $2) RETURNING id`,
        [driverId, total],
      );
      const invoiceId = inv[0]!.id;
      await pool.query(
        `INSERT INTO membership_payments (driver_id, membership_id, invoice_id, amount_usd, status, paid_at)
         VALUES ($1, $2, $3, $4, 'paid', now())`,
        [driverId, membership.id, invoiceId, membership.price],
      );
      const { rows: sub } = await pool.query<{ id: string }>(
        `INSERT INTO driver_subscriptions (driver_id, plan_id, status) VALUES ($1, $2, 'scheduled') RETURNING id`,
        [driverId, plan.id],
      );
      await pool.query(
        `INSERT INTO subscription_payments
           (driver_subscription_id, invoice_id, period_start, period_end, amount_usd, status)
         VALUES ($1, $2, ${ALTA_MONDAY}, ${ALTA_MONDAY} + interval '7 days', $3, 'pending')`,
        [sub[0]!.id, invoiceId, plan.price],
      );
      console.log(`   DEMO PagoParcial (membresía pagada, semana por cobrar → factura "Emitida").`);
    }

    // D) VOIDED invoice (what a rejection leaves behind): charges refunded and
    //    the invoice annulled — "Anulada" must win over any paid charge.
    {
      const driverId = await makeUser('DEMO', 'Anulada', 'rejected');
      const { rows: inv } = await pool.query<{ id: string }>(
        `INSERT INTO invoices (driver_id, total_usd, status, voided_at)
         VALUES ($1, $2, 'voided', now()) RETURNING id`,
        [driverId, membership.price],
      );
      await pool.query(
        `INSERT INTO membership_payments
           (driver_id, membership_id, invoice_id, amount_usd, status, paid_at, refunded_at)
         VALUES ($1, $2, $3, $4, 'refunded', now(), now())`,
        [driverId, membership.id, inv[0]!.id, membership.price],
      );
      console.log('   DEMO Anulada (rechazado: pago reembolsado y factura anulada).');
    }

    console.log('\n✅ Listo. Abre Afiliados o Facturación en el panel para verlos.\n');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
