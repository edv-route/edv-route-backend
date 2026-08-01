import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { BillingRepository, type InvoiceListItem } from '../src/modules/billing/billing.repository.js';
import { removeDriver as removeDriverFixture } from './helpers/db-fixtures.js';

/**
 * DERIVED invoice state (Fase 3, 2026-07-30): `/invoices` reports Emitida /
 * Pagada / Anulada out of the invoice's CHARGES, with no schema change, and
 * exposes the settlement date. Covers the option-A cycle end to end
 * (registration without payment -> debt invoice -> external payment -> paid)
 * plus the edge cases of the derivation. Every test removes its own data.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let billing: BillingRepository;
let token: string;

before(async () => {
  app = await buildApp();
  await app.ready();
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  billing = new BillingRepository(pool);
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'admin', password: 'EdvRoute2026' },
  });
  token = (login.json() as { token: string }).token;
});
after(async () => {
  await pool.end();
  await app.close();
});

const auth = () => ({ authorization: `Bearer ${token}` });

const removeDriver = (driverId: string): Promise<void> => removeDriverFixture(pool, driverId);

/** Throwaway pending driver with a weekly subscription to hang charges on. */
async function makeDriver(tag: string): Promise<{ driverId: string; subId: string }> {
  const { rows: u } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name) VALUES ('TEST', $1, $2) RETURNING id`,
    [tag, `TEST ${tag}`],
  );
  const driverId = u[0]!.id;
  await pool.query(`INSERT INTO drivers (user_id, source, status) VALUES ($1, 'admin', 'pending')`, [driverId]);
  const { rows: p } = await pool.query<{ id: number }>(
    `SELECT id FROM subscription_plans WHERE billing_period = 'weekly' AND active ORDER BY id LIMIT 1`,
  );
  assert.ok(p[0], 'necesita una tarifa semanal activa para la prueba');
  const { rows: s } = await pool.query<{ id: string }>(
    `INSERT INTO driver_subscriptions (driver_id, plan_id, status) VALUES ($1, $2, 'scheduled') RETURNING id`,
    [driverId, p[0].id],
  );
  return { driverId, subId: s[0]!.id };
}

const makeInvoice = async (driverId: string, total: number): Promise<string> =>
  (await pool.query<{ id: string }>(
    `INSERT INTO invoices (driver_id, total_usd) VALUES ($1, $2) RETURNING id`,
    [driverId, total],
  )).rows[0]!.id;

/** A tariff week tied to an invoice; `paid` rows get paid_at = now() - offset. */
const addWeek = (
  subId: string,
  invoiceId: string | null,
  status: 'pending' | 'paid' | 'refunded',
  paidOffset = '0 seconds',
): Promise<unknown> =>
  pool.query(
    // $3 travels as TEXT and is cast to the enum once, so Postgres deduces a
    // single type for it (it is also compared as text below).
    `INSERT INTO subscription_payments
       (driver_subscription_id, invoice_id, period_start, period_end, amount_usd, status, paid_at)
     VALUES ($1, $2, now(), now() + interval '7 days', 10, $3::text::subscription_payment_status,
             CASE WHEN $3::text = 'paid' THEN now() - $4::interval END)`,
    [subId, invoiceId, status, paidOffset],
  );

/** The one invoice of a driver, as the list endpoint reports it. */
async function invoiceOf(driverId: string): Promise<InvoiceListItem> {
  const { items } = await billing.listInvoices({ driverId, page: 1, limit: 20 });
  assert.equal(items.length, 1, 'el afiliado de prueba tiene exactamente una factura');
  return items[0]!;
}

test('derivación: una factura sin cargos NO es "pagada" (queda Emitida)', async () => {
  const { driverId } = await makeDriver('InvStateEmpty');
  try {
    await makeInvoice(driverId, 25);
    const invoice = await invoiceOf(driverId);
    assert.equal(invoice.status, 'issued', 'sin cargos no hay nada que dar por pagado');
    assert.equal(invoice.paidAt, null, 'sin fecha de pago');
  } finally {
    await removeDriver(driverId);
  }
});

test('derivación: pago PARCIAL de sus cargos sigue siendo Emitida (sin fecha de pago)', async () => {
  const { driverId, subId } = await makeDriver('InvStatePartial');
  try {
    const invoiceId = await makeInvoice(driverId, 20);
    await addWeek(subId, invoiceId, 'paid');
    await addWeek(subId, invoiceId, 'pending');
    const invoice = await invoiceOf(driverId);
    assert.equal(invoice.status, 'issued', 'mientras quede un cargo por pagar, no está pagada');
    assert.equal(invoice.paidAt, null, 'la fecha de pago solo existe si se saldó por completo');
  } finally {
    await removeDriver(driverId);
  }
});

test('derivación: con TODOS sus cargos pagados es Pagada, con fecha = el pago más reciente', async () => {
  const { driverId, subId } = await makeDriver('InvStatePaid');
  try {
    const invoiceId = await makeInvoice(driverId, 20);
    await addWeek(subId, invoiceId, 'paid', '2 hours');
    await addWeek(subId, invoiceId, 'paid', '10 minutes');
    const invoice = await invoiceOf(driverId);
    assert.equal(invoice.status, 'paid', 'todos los cargos pagados = factura pagada');
    assert.ok(invoice.paidAt, 'expone la fecha de pago');

    const { rows } = await pool.query<{ max: Date }>(
      `SELECT max(paid_at) AS max FROM subscription_payments WHERE invoice_id = $1`,
      [invoiceId],
    );
    assert.equal(
      new Date(invoice.paidAt!).getTime(),
      new Date(rows[0]!.max).getTime(),
      'la fecha de pago es la del último cargo saldado',
    );
  } finally {
    await removeDriver(driverId);
  }
});

test('derivación: Anulada manda sobre Pagada', async () => {
  const { driverId, subId } = await makeDriver('InvStateVoided');
  try {
    const invoiceId = await makeInvoice(driverId, 10);
    await addWeek(subId, invoiceId, 'paid');
    await pool.query(`UPDATE invoices SET status = 'voided', voided_at = now() WHERE id = $1`, [invoiceId]);
    const invoice = await invoiceOf(driverId);
    assert.equal(invoice.status, 'voided', 'una factura anulada nunca se muestra como pagada');
  } finally {
    await removeDriver(driverId);
  }
});

test('filtro por estado derivado: issued / paid / voided seleccionan lo mismo que muestra la lista', async () => {
  const owed = await makeDriver('InvFilterOwed');
  const settled = await makeDriver('InvFilterPaid');
  try {
    const owedInvoice = await makeInvoice(owed.driverId, 10);
    await addWeek(owed.subId, owedInvoice, 'pending');
    const paidInvoice = await makeInvoice(settled.driverId, 10);
    await addWeek(settled.subId, paidInvoice, 'paid');

    const byStatus = async (status: string, driverId: string): Promise<number> =>
      (await billing.listInvoices({ status, driverId, page: 1, limit: 20 })).total;

    assert.equal(await byStatus('issued', owed.driverId), 1, 'la impaga filtra como Emitida');
    assert.equal(await byStatus('paid', owed.driverId), 0, 'y NO como Pagada');
    assert.equal(await byStatus('paid', settled.driverId), 1, 'la saldada filtra como Pagada');
    assert.equal(await byStatus('issued', settled.driverId), 0, 'y NO como Emitida');
    assert.equal(await byStatus('voided', settled.driverId), 0, 'ninguna está anulada');
  } finally {
    await removeDriver(owed.driverId);
    await removeDriver(settled.driverId);
  }
});

test('ciclo opción A (E2E): alta sin pago = factura Emitida -> pago externo = Pagada con fecha', async () => {
  let driverId = '';
  try {
    // Registration WITHOUT payment: emits the debt invoice (membership + 1 week).
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/register',
      headers: auth(),
      payload: { firstName: 'TEST', lastName: 'InvoiceState', nationalId: 'V-99999003' },
    });
    assert.equal(registered.statusCode, 201, registered.body);
    driverId = (registered.json() as { userId: string }).userId;

    const list = async (query = ''): Promise<{ items: InvoiceListItem[]; total: number }> =>
      (await app.inject({
        method: 'GET',
        url: `/api/v1/invoices?driverId=${driverId}${query}`,
        headers: auth(),
      })).json();

    const debt = await list();
    assert.equal(debt.total, 1, 'el alta sin pago emite una sola factura de deuda');
    assert.equal(debt.items[0]!.status, 'issued', 'nace Emitida: el dinero aún no entró');
    assert.equal(debt.items[0]!.paidAt, null, 'sin fecha de pago');
    assert.equal((await list('&status=paid')).total, 0, 'no aparece entre las pagadas');

    // The admin registers the money received outside the system.
    const settle = await app.inject({
      method: 'POST',
      url: `/api/v1/drivers/${driverId}/external-payment`,
      headers: auth(),
      payload: { note: 'TEST saldo del alta' },
    });
    assert.equal(settle.statusCode, 201, settle.body);

    const paid = await list();
    assert.equal(paid.total, 1, 'saldar el alta NO emite una factura nueva: reusa la de la deuda');
    assert.equal(paid.items[0]!.id, debt.items[0]!.id, 'es la misma factura');
    assert.equal(paid.items[0]!.status, 'paid', 'ahora se lee como Pagada');
    assert.ok(paid.items[0]!.paidAt, 'con su fecha de pago');
    assert.equal(
      new Date(paid.items[0]!.issuedAt).getTime() <= new Date(paid.items[0]!.paidAt!).getTime(),
      true,
      'la fecha de pago nunca es anterior a la de emisión',
    );
    assert.equal((await list('&status=paid')).total, 1, 'y filtra entre las pagadas');
  } finally {
    if (driverId) await removeDriver(driverId);
  }
});
