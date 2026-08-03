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
    })).json()) as { status: string; invoiceId: string | null };
    assert.equal(sub.status, 'approved');
    assert.ok(sub.invoiceId, 'el envío queda enlazado a su factura');

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

test('a second pending submission is rejected (one per driver)', async () => {
  let driverId = '';
  let methodId = 0;
  try {
    methodId = await createMethod();
    const created = await newDriverWithDebt('V-99991003');
    driverId = created.driverId;

    await insertPending(driverId, created.debt, methodId, 'REFV9ONE');
    await assert.rejects(
      () => insertPending(driverId, created.debt, methodId, 'REFV9TWO'),
      /payment_submissions_one_pending_per_driver|duplicate key/,
      'la BD impide un segundo envío pendiente',
    );
  } finally {
    if (driverId) await removeDriver(driverId);
    if (methodId) await app.inject({ method: 'DELETE', url: `/api/v1/payment-methods/${methodId}`, headers: auth() });
  }
});

test('approve of an ADVANCE emits ONE invoice for the N weeks (2B fix)', async () => {
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
    assert.ok(sub.invoiceId, 'el adelanto queda enlazado a su factura');

    // ONE invoice for the whole advance, with N weekly charges under it.
    const inv = await pool.query<{ total: string }>(
      `SELECT total_usd::text AS total FROM invoices WHERE id = $1`, [sub.invoiceId]);
    assert.equal(Number(inv.rows[0]!.total).toFixed(2), (price * periods).toFixed(2), 'la factura agrupa las N semanas');
    const cnt = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM subscription_payments
       WHERE invoice_id = $1 AND submission_id = $2 AND status = 'paid'`, [sub.invoiceId, submissionId]);
    assert.equal(cnt.rows[0]!.n, String(periods), 'las N semanas comparten UNA sola factura');
  } finally {
    if (driverId) await removeDriver(driverId);
    if (methodId) await app.inject({ method: 'DELETE', url: `/api/v1/payment-methods/${methodId}`, headers: auth() });
  }
});
