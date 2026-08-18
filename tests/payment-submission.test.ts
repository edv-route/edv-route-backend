import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { removeDriver as removeDriverFixture } from './helpers/db-fixtures.js';

/**
 * Payment approval flow (v9): a pending submission, once approved, settles the
 * driver's debt and stamps the payment meta on the resulting invoice; once
 * rejected, the debt stays with a trace. Inserts the submission via SQL (no
 * Storage side effect) and drives approve/reject through the HTTP endpoints.
 * Uses app.inject() (no port). Cleans up its own data.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let token: string;

before(async () => {
  app = await buildApp();
  await app.ready();
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const login = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
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

/** Registers a driver WITHOUT payment so the alta emits debt (membership + 1 week). */
async function newDriverWithDebt(nationalId: string): Promise<{ driverId: string; debt: string }> {
  const d = await app.inject({
    method: 'POST', url: '/api/v1/drivers/register', headers: auth(),
    payload: { firstName: 'TEST', lastName: 'Submission', nationalId, payment: null, vehicles: [], documents: [] },
  });
  const driverId = (d.json() as { userId: string }).userId;
  const detail = (await (await app.inject({
    method: 'GET', url: `/api/v1/drivers/${driverId}`, headers: auth(),
  })).json()) as { debt: { totalUsd: string } };
  return { driverId, debt: detail.debt.totalUsd };
}

async function createMethod(): Promise<number> {
  const m = await app.inject({
    method: 'POST', url: '/api/v1/payment-methods', headers: auth(),
    payload: { name: 'TEST Zelle v9', type: 'zelle', details: { email: 'v9@test.com', holder: 'EDV' } },
  });
  return (m.json() as { id: number }).id;
}

/** Inserts a pending submission directly (bypasses the multipart/Storage upload). */
async function insertPending(driverId: string, amountUsd: string, methodId: number, reference: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO payment_submissions
       (driver_id, amount_usd, payment_method_id, payment_reference, source, status)
     VALUES ($1, $2, $3, $4, 'admin', 'pending') RETURNING id`,
    [driverId, amountUsd, methodId, reference],
  );
  return rows[0]!.id;
}

/** Reserves an invoice for a submission (what a partial payment records). */
const reserve = (submissionId: string, invoiceId: string): Promise<unknown> =>
  pool.query(
    `INSERT INTO payment_submission_invoices (submission_id, invoice_id, submission_status)
     VALUES ($1, $2, 'pending')`,
    [submissionId, invoiceId],
  );

test('approve settles the debt and stamps the invoice', async () => {
  let driverId = '';
  let methodId = 0;
  try {
    methodId = await createMethod();
    const created = await newDriverWithDebt('V-99991001');
    driverId = created.driverId;
    assert.ok(Number(created.debt) > 0, 'el alta debe generar deuda (requiere membresía + tarifa semanal activas)');

    const submissionId = await insertPending(driverId, created.debt, methodId, 'REFV9APPR');

    const approve = await app.inject({
      method: 'POST', url: `/api/v1/payment-submissions/${submissionId}/approve`, headers: auth(),
    });
    assert.equal(approve.statusCode, 200, 'aprobar responde 200');
    const result = approve.json() as { invoiceNumber: string; settledCharges: number };
    assert.ok(result.settledCharges >= 2, 'salda al menos membresía + 1 semana');

    // Debt is gone and the submission is approved with its invoice linked.
    const detail = (await (await app.inject({
      method: 'GET', url: `/api/v1/drivers/${driverId}`, headers: auth(),
    })).json()) as { debt: { totalUsd: string }; membershipPayment: { status: string } | null };
    assert.equal(Number(detail.debt.totalUsd), 0, 'la deuda queda saldada');
    assert.equal(detail.membershipPayment?.status, 'paid', 'la membresía queda pagada');

    const sub = (await (await app.inject({
      method: 'GET', url: `/api/v1/payment-submissions/${submissionId}`, headers: auth(),
    })).json()) as { status: string; invoiceId: string | null; items: unknown[] };
    assert.equal(sub.status, 'approved');
    // Billing redesign 2026-08-04: ONE INVOICE PER CONCEPT and a receipt covers
    // N of them, so there is no single "the receipt's invoice" any more. What the
    // receipt does carry is the list of what it settled.
    assert.equal(sub.invoiceId, null, 'un recibo cubre N facturas, no una');
    assert.ok(sub.items.length >= 2, 'el recibo detalla la membresía y la semana');

    // The invoice carries the stamped reference.
    const list = (await (await app.inject({
      method: 'GET', url: `/api/v1/invoices?driverId=${driverId}`, headers: auth(),
    })).json()) as { items: { id: string; status: string; paymentReference: string | null }[] };
    const invoice = list.items.find((i) => i.id === sub.invoiceId);
    assert.ok(invoice, 'la factura del envío aparece en el listado');
    assert.equal(invoice!.status, 'paid', 'la factura queda pagada');
    assert.equal(invoice!.paymentReference, 'REFV9APPR', 'la referencia del pago queda estampada');
  } finally {
    if (driverId) await removeDriver(driverId);
    if (methodId) await app.inject({ method: 'DELETE', url: `/api/v1/payment-methods/${methodId}`, headers: auth() });
  }
});

test('reject keeps the debt with a trace', async () => {
  let driverId = '';
  let methodId = 0;
  try {
    methodId = await createMethod();
    const created = await newDriverWithDebt('V-99991002');
    driverId = created.driverId;
    assert.ok(Number(created.debt) > 0);

    const submissionId = await insertPending(driverId, created.debt, methodId, 'REFV9REJ');

    const reject = await app.inject({
      method: 'POST', url: `/api/v1/payment-submissions/${submissionId}/reject`, headers: auth(),
      payload: { reason: 'Comprobante ilegible' },
    });
    assert.equal(reject.statusCode, 204, 'rechazar responde 204');

    const sub = (await (await app.inject({
      method: 'GET', url: `/api/v1/payment-submissions/${submissionId}`, headers: auth(),
    })).json()) as { status: string; rejectionReason: string | null };
    assert.equal(sub.status, 'rejected');
    assert.equal(sub.rejectionReason, 'Comprobante ilegible');

    // Debt is untouched.
    const detail = (await (await app.inject({
      method: 'GET', url: `/api/v1/drivers/${driverId}`, headers: auth(),
    })).json()) as { debt: { totalUsd: string } };
    assert.equal(detail.debt.totalUsd, created.debt, 'la deuda queda intacta tras el rechazo');
  } finally {
    if (driverId) await removeDriver(driverId);
    if (methodId) await app.inject({ method: 'DELETE', url: `/api/v1/payment-methods/${methodId}`, headers: auth() });
  }
});

/**
 * The rule changed on 2026-08-12: a driver MAY have several payments under
 * review at once (he must be able to pay while the office reviews an earlier
 * receipt; blocking him would put him in arrears through OUR review latency).
 * What stays forbidden — and is now guaranteed by the database instead of by
 * application code — is two pending payments reserving the SAME invoice.
 */
test('several pending payments are allowed; two on the same invoice are not', async () => {
  let driverId = '';
  let methodId = 0;
  try {
    methodId = await createMethod();
    const created = await newDriverWithDebt('V-99991003');
    driverId = created.driverId;

    const { rows: invoices } = await pool.query<{ id: string }>(
      `SELECT id FROM invoices WHERE driver_id = $1 ORDER BY invoice_number`,
      [driverId],
    );
    assert.ok(invoices.length >= 1, 'el alta debe emitir al menos una factura');
    const invoiceId = invoices[0]!.id;

    const first = await insertPending(driverId, created.debt, methodId, 'REFV9ONE');
    const second = await insertPending(driverId, created.debt, methodId, 'REFV9TWO');
    assert.ok(second, 'varios pagos en revisión SÍ están permitidos desde 2026-08-12');

    await reserve(first, invoiceId);
    await assert.rejects(
      () => reserve(second, invoiceId),
      /one_pending_per_invoice|duplicate key/,
      'la BD impide que dos pagos pendientes reserven la misma factura',
    );

    // Once the first one is resolved the invoice is free again: the reservation
    // follows the payment's status by trigger, nobody has to remember to clear it.
    await pool.query(`UPDATE payment_submissions SET status = 'rejected' WHERE id = $1`, [first]);
    await reserve(second, invoiceId);
  } finally {
    if (driverId) await removeDriver(driverId);
    if (methodId) await app.inject({ method: 'DELETE', url: `/api/v1/payment-methods/${methodId}`, headers: auth() });
  }
});

test('approve of an ADVANCE emits one invoice PER WEEK, all on the receipt', async () => {
  let driverId = '';
  let methodId = 0;
  const periods = 4;
  try {
    methodId = await createMethod();
    const created = await newDriverWithDebt('V-99991004');
    driverId = created.driverId;

    // The alta emitted a subscription (scheduled) with the weekly price. approve
    // of an `advance` operates on that subscription id via the stored context.
    const detail = (await (await app.inject({
      method: 'GET', url: `/api/v1/drivers/${driverId}`, headers: auth(),
    })).json()) as { subscription: { id: string; priceUsd: string } | null };
    assert.ok(detail.subscription, 'el alta crea una suscripción');
    const subId = detail.subscription!.id;
    const price = Number(detail.subscription!.priceUsd);

    const context = {
      subscriptionId: subId, planPriceUsd: price, periods,
      periodInterval: '7 days', timezone: 'America/Caracas',
      reactivate: false, anchorWeekly: false,
    };
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO payment_submissions
         (driver_id, amount_usd, payment_method_id, payment_reference, source, status, purpose, context)
       VALUES ($1, $2, $3, $4, 'admin', 'pending', 'advance', $5::jsonb) RETURNING id`,
      [driverId, (price * periods).toFixed(2), methodId, 'REFV9ADV', JSON.stringify(context)],
    );
    const submissionId = rows[0]!.id;

    const approve = await app.inject({
      method: 'POST', url: `/api/v1/payment-submissions/${submissionId}/approve`, headers: auth(),
    });
    assert.equal(approve.statusCode, 200);

    const sub = (await (await app.inject({
      method: 'GET', url: `/api/v1/payment-submissions/${submissionId}`, headers: auth(),
    })).json()) as { status: string; invoiceId: string | null };
    assert.equal(sub.status, 'approved');
    assert.equal(sub.invoiceId, null, 'el adelanto cubre N facturas, no una');

    // One invoice PER WEEK (redesign 2026-08-04), all linked to the receipt and
    // adding up to what was charged.
    const inv = await pool.query<{ n: string; suma: string }>(
      `SELECT count(*)::text AS n, sum(total_usd)::text AS suma
       FROM invoices WHERE submission_id = $1`, [submissionId]);
    assert.equal(inv.rows[0]!.n, String(periods), 'una factura por cada semana adelantada');
    assert.equal(Number(inv.rows[0]!.suma).toFixed(2), (price * periods).toFixed(2), 'las facturas suman el adelanto');
    const cnt = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM subscription_payments
       WHERE submission_id = $1 AND status = 'paid'`, [submissionId]);
    assert.equal(cnt.rows[0]!.n, String(periods), 'las N semanas quedan pagadas');
  } finally {
    if (driverId) await removeDriver(driverId);
    if (methodId) await app.inject({ method: 'DELETE', url: `/api/v1/payment-methods/${methodId}`, headers: auth() });
  }
});

test('approve of an ENROLL emits one invoice per concept (membership + N weeks)', async () => {
  let driverId = '';
  let methodId = 0;
  const periods = 2;
  try {
    methodId = await createMethod();
    // Plain driver (create, no payment) → no membership payment yet.
    const d = await app.inject({
      method: 'POST', url: '/api/v1/drivers', headers: auth(),
      payload: { firstName: 'TEST', lastName: 'Enroll', nationalId: 'V-99991005' },
    });
    driverId = (d.json() as { userId: string }).userId;

    const { rows: mem } = await pool.query<{ id: string; price: string }>(
      `SELECT id, price_usd AS price FROM memberships WHERE active LIMIT 1`);
    const { rows: pl } = await pool.query<{ id: string; price: string }>(
      `SELECT id, price_usd AS price FROM subscription_plans
       WHERE active AND billing_period = 'weekly' ORDER BY id LIMIT 1`);
    assert.ok(mem[0] && pl[0], 'necesita membresía + tarifa semanal activas');
    const memberPrice = Number(mem[0]!.price);
    const planPrice = Number(pl[0]!.price);
    const total = memberPrice + planPrice * periods;
    const context = {
      membershipId: Number(mem[0]!.id), membershipPriceUsd: memberPrice,
      planId: Number(pl[0]!.id), planPriceUsd: planPrice, periods, periodInterval: '7 days',
    };

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO payment_submissions
         (driver_id, amount_usd, payment_method_id, payment_reference, source, status, purpose, context)
       VALUES ($1, $2, $3, 'REFV9ENR', 'admin', 'pending', 'enroll', $4::jsonb) RETURNING id`,
      [driverId, total.toFixed(2), methodId, JSON.stringify(context)]);
    const submissionId = rows[0]!.id;

    const approve = await app.inject({
      method: 'POST', url: `/api/v1/payment-submissions/${submissionId}/approve`, headers: auth() });
    assert.equal(approve.statusCode, 200);
    assert.equal((approve.json() as { settledCharges: number }).settledCharges, 1 + periods, 'membresía + N semanas');

    const detail = (await (await app.inject({
      method: 'GET', url: `/api/v1/drivers/${driverId}`, headers: auth() })).json()) as {
      membershipPayment: { status: string } | null; subscription: unknown;
    };
    assert.equal(detail.membershipPayment?.status, 'paid', 'la membresía queda pagada');
    assert.ok(detail.subscription, 'crea la suscripción');

    const sub = (await (await app.inject({
      method: 'GET', url: `/api/v1/payment-submissions/${submissionId}`, headers: auth() })).json()) as { invoiceId: string | null };
    assert.equal(sub.invoiceId, null, 'el alta cubre N facturas, no una');
    // One per concept: the membership plus one per week (redesign 2026-08-04).
    const inv = await pool.query<{ n: string; suma: string }>(
      `SELECT count(*)::text AS n, sum(total_usd)::text AS suma
       FROM invoices WHERE submission_id = $1`, [submissionId]);
    assert.equal(inv.rows[0]!.n, String(1 + periods), 'una factura por la membresía y una por semana');
    assert.equal(Number(inv.rows[0]!.suma).toFixed(2), total.toFixed(2), 'las facturas suman el alta');
  } finally {
    if (driverId) await removeDriver(driverId);
    if (methodId) await app.inject({ method: 'DELETE', url: `/api/v1/payment-methods/${methodId}`, headers: auth() });
  }
});
