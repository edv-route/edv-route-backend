import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { removeDriver as removeDriverFixture } from './helpers/db-fixtures.js';

/**
 * Backend validation contract (2026-07-31): the API must reject what the panel
 * rejects — name character/length rules, digits-only cédula/phone, the payment
 * reference format, and the new payer fields (paid date + Pago-Móvil phone/id).
 * Uses app.inject() (no port). Cleans up any driver it creates.
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

const createDriver = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/v1/drivers', headers: auth(), payload });

test('names: rejects digits/symbols, accepts accents and ñ', async () => {
  // A name with digits/symbols is rejected (400) by the pattern.
  const bad = await createDriver({ firstName: 'f5454/-+#$%', lastName: 'Pérez' });
  assert.equal(bad.statusCode, 400, 'un nombre con números/símbolos debe rechazarse');

  // Accents and ñ pass; the driver is created (then cleaned up).
  const ok = await createDriver({ firstName: 'Ángel', lastName: 'Muñoz De La Cruz' });
  assert.equal(ok.statusCode, 201, ok.body);
  const driverId = (ok.json() as { userId: string }).userId;
  await removeDriver(driverId);
});

test('names: rejects doubled or edge separators', async () => {
  // "fgdfgd----------": a run of separators must be rejected.
  const doubled = await createDriver({ firstName: 'fgdfgd----------', lastName: 'Pérez' });
  assert.equal(doubled.statusCode, 400, 'separadores repetidos se rechazan');

  const edge = await createDriver({ firstName: '-Ana', lastName: 'Pérez' });
  assert.equal(edge.statusCode, 400, 'un separador al inicio se rechaza');

  // A single hyphen between letters is still fine ("Ana-María").
  const ok = await createDriver({ firstName: 'Ana-María', lastName: "O'Brien" });
  assert.equal(ok.statusCode, 201, ok.body);
  await removeDriver((ok.json() as { userId: string }).userId);
});

test('names: rejects over 80 characters', async () => {
  const long = 'A'.repeat(81);
  const res = await createDriver({ firstName: long, lastName: 'Pérez' });
  assert.equal(res.statusCode, 400, 'un nombre de 81 caracteres debe rechazarse (máx 80)');
});

test('cédula and phone: canonical formats enforced', async () => {
  const badId = await createDriver({ firstName: 'Rosa', lastName: 'Díaz', nationalId: 'ABC' });
  assert.equal(badId.statusCode, 400, 'cédula que no es V/E/J-dígitos se rechaza');

  const badPhone = await createDriver({ firstName: 'Rosa', lastName: 'Díaz', phone: '04121234567' });
  assert.equal(badPhone.statusCode, 400, 'teléfono sin +58 / 10 dígitos se rechaza');

  const ok = await createDriver({
    firstName: 'Rosa', lastName: 'Díaz', nationalId: 'V-12345670', phone: '+584121234567',
  });
  assert.equal(ok.statusCode, 201, ok.body);
  await removeDriver((ok.json() as { userId: string }).userId);
});

test('vehicle: brand allows digits, color rejects them', async () => {
  const driver = await createDriver({ firstName: 'Vehi', lastName: 'Culo' });
  const driverId = (driver.json() as { userId: string }).userId;
  try {
    // "Mazda 3" (digits) is a valid brand.
    const okBrand = await app.inject({
      method: 'POST', url: `/api/v1/drivers/${driverId}/vehicles`, headers: auth(),
      payload: { brand: 'Mazda 3', model: 'F-150', year: 2020, color: 'Gris', plate: 'AB123CD' },
    });
    assert.equal(okBrand.statusCode, 201, okBrand.body);

    // A color with digits is rejected.
    const badColor = await app.inject({
      method: 'POST', url: `/api/v1/drivers/${driverId}/vehicles`, headers: auth(),
      payload: { brand: 'Toyota', color: 'Gris4' },
    });
    assert.equal(badColor.statusCode, 400, 'un color con números se rechaza');
  } finally {
    await removeDriver(driverId);
  }
});

test('payment reference: symbols rejected, alphanumeric accepted; payer fields validated', async () => {
  // active weekly plan for enroll
  const plans = (await (await app.inject({
    method: 'GET', url: '/api/v1/subscription-plans', headers: auth(),
  })).json()) as { id: number; active: boolean; billingPeriod: string }[];
  const weekly = plans.find((p) => p.active && p.billingPeriod === 'weekly');
  assert.ok(weekly, 'necesita una tarifa semanal activa');

  const driver = await createDriver({ firstName: 'Refe', lastName: 'Rencia' });
  const driverId = (driver.json() as { userId: string }).userId;
  try {
    const enroll = (body: Record<string, unknown>) =>
      app.inject({
        method: 'POST', url: `/api/v1/drivers/${driverId}/enroll`, headers: auth(),
        payload: { planId: weekly!.id, periods: 1, ...body },
      });

    const badRef = await enroll({ reference: 'REF-#12/34' });
    assert.equal(badRef.statusCode, 400, 'una referencia con símbolos se rechaza');

    const badPaidOn = await enroll({ reference: 'REF12345', paidOn: '31/07/2026' });
    assert.equal(badPaidOn.statusCode, 400, 'una fecha de pago no-ISO se rechaza');

    const badPayerId = await enroll({ reference: 'REF12345', payerId: '123' });
    assert.equal(badPayerId.statusCode, 400, 'una cédula del pagador inválida se rechaza');

    const ok = await enroll({
      reference: 'REF12345', paidOn: '2026-07-31',
      payerPhone: '+584121234567', payerId: 'V-12345678',
    });
    assert.equal(ok.statusCode, 201, ok.body);
  } finally {
    await removeDriver(driverId);
  }
});

test('payment method: invalid email rejected, valid accepted (Zelle)', async () => {
  // Zelle accepts an email OR a phone: a value with '@' must be a valid email.
  const bad = await app.inject({
    method: 'POST', url: '/api/v1/payment-methods', headers: auth(),
    payload: { name: 'TEST Zelle', type: 'zelle', details: { email: 'bad@nope', holder: 'EDV' } },
  });
  assert.equal(bad.statusCode, 400, 'un correo con @ inválido se rechaza');

  const ok = await app.inject({
    method: 'POST', url: '/api/v1/payment-methods', headers: auth(),
    payload: { name: 'TEST Zelle', type: 'zelle', details: { email: 'pagos@test.com', holder: 'EDV' } },
  });
  assert.equal(ok.statusCode, 201, ok.body);
  await app.inject({
    method: 'DELETE', url: `/api/v1/payment-methods/${(ok.json() as { id: number }).id}`, headers: auth(),
  });
});

test('payment method: removed types (paypal/crypto/contact) are rejected', async () => {
  for (const type of ['paypal', 'crypto', 'contact']) {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/payment-methods', headers: auth(),
      payload: { name: `TEST ${type}`, type, details: {} },
    });
    assert.equal(res.statusCode, 400, `el tipo ${type} ya no se acepta`);
  }
});
