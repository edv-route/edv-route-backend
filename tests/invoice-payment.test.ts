import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { removeDriver as removeDriverFixture } from './helpers/db-fixtures.js';

/**
 * Payment details on the invoice (Pieza 2): method + reference + payer bank are
 * stamped on the primary invoice at enroll time and surface in the invoice list.
 * Uses app.inject() (no port). Does NOT upload a real file (Storage side effect);
 * only checks the receipt endpoint's 404 path. Cleans up its own data.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let token: string;

before(async () => {
  app = await buildApp();
  await app.ready();
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
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

test('enroll stamps payment method + reference on the invoice', async () => {
  let driverId = '';
  let methodId = 0;
  try {
    // active weekly plan
    const plans = (await (await app.inject({ method: 'GET', url: '/api/v1/subscription-plans', headers: auth() })).json()) as any[];
    const weekly = plans.find((p) => p.active && p.billingPeriod === 'weekly');
    assert.ok(weekly, 'necesita una tarifa semanal activa');

    // a payment method to reference
    const m = await app.inject({
      method: 'POST', url: '/api/v1/payment-methods', headers: auth(),
      payload: { name: 'TEST Pago', type: 'zelle', details: { email: 'pagos@test.com', holder: 'EDV' } },
    });
    methodId = (m.json() as { id: number }).id;

    // throwaway driver, no payment yet
    const d = await app.inject({
      method: 'POST', url: '/api/v1/drivers', headers: auth(),
      payload: {
        firstName: 'TEST',
        lastName: 'InvoiceMeta',
        nationalId: 'V-99999002',
        email: 'invoice-meta@edvroute.test',
      },
    });
    driverId = (d.json() as { userId: string }).userId;

    // enroll WITH payment details
    const e = await app.inject({
      method: 'POST', url: `/api/v1/drivers/${driverId}/enroll`, headers: auth(),
      payload: {
        planId: weekly.id, periods: 1,
        paymentMethodId: methodId, reference: 'REF12345', payerBank: '0134 - Banesco',
      },
    });
    assert.equal(e.statusCode, 201);
    const enrolled = e.json() as { primaryInvoiceId: string | null; invoiceNumbers: string[] };
    assert.ok(enrolled.primaryInvoiceId, 'devuelve el id de la factura primaria');

    // the invoice list surfaces the payment details
    const list = (await (await app.inject({
      method: 'GET', url: `/api/v1/invoices?driverId=${driverId}`, headers: auth(),
    })).json()) as { items: any[] };
    const invoice = list.items.find((i) => i.id === enrolled.primaryInvoiceId);
    assert.ok(invoice, 'la factura primaria aparece en el listado');
    assert.equal(invoice.paymentMethodName, 'TEST Pago');
    assert.equal(invoice.paymentReference, 'REF12345');
    assert.equal(invoice.payerBank, '0134 - Banesco');
    assert.equal(invoice.hasProof, false, 'sin comprobante todavía');

    // no receipt yet -> 404
    const proof = await app.inject({
      method: 'GET', url: `/api/v1/invoices/${enrolled.primaryInvoiceId}/proof`, headers: auth(),
    });
    assert.equal(proof.statusCode, 404, 'sin comprobante = 404');
  } finally {
    if (driverId) await removeDriver(driverId);
    if (methodId) await app.inject({ method: 'DELETE', url: `/api/v1/payment-methods/${methodId}`, headers: auth() });
  }
});
