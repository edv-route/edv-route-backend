import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

/**
 * Payment methods CRUD via app.inject() — NO port is opened, so this never
 * collides with a running dev server. Cleans up the rows it creates.
 */

let app: FastifyInstance;
let token: string;

before(async () => {
  app = await buildApp();
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'admin', password: 'EdvRoute2026' },
  });
  token = (login.json() as { token: string }).token;
});
after(async () => {
  await app.close();
});

const auth = () => ({ authorization: `Bearer ${token}` });

test('payment methods: CRUD + per-type validation', async () => {
  const created: number[] = [];
  try {
    // create a bank_transfer with all required details
    const c = await app.inject({
      method: 'POST', url: '/api/v1/payment-methods', headers: auth(),
      payload: {
        name: 'TEST Banesco Ahorro', type: 'bank_transfer',
        details: {
          bank: 'Banesco', accountNumber: '0134-1234', accountType: 'ahorro',
          accountHolder: 'Juan Pérez', idDocument: 'V-12345678',
        },
      },
    });
    assert.equal(c.statusCode, 201);
    const rec = c.json() as { id: number; type: string; details: Record<string, unknown>; isActive: boolean };
    created.push(rec.id);
    assert.equal(rec.type, 'bank_transfer');
    assert.equal(rec.details['bank'], 'Banesco');
    assert.equal(rec.isActive, true);

    // missing required field for the type -> 400
    const bad = await app.inject({
      method: 'POST', url: '/api/v1/payment-methods', headers: auth(),
      payload: { name: 'TEST Binance', type: 'binance', details: {} },
    });
    assert.equal(bad.statusCode, 400, 'binance sin identifier debe fallar');

    // unknown type rejected by the JSON schema (enum) -> 400
    const badType = await app.inject({
      method: 'POST', url: '/api/v1/payment-methods', headers: auth(),
      payload: { name: 'TEST X', type: 'nope', details: {} },
    });
    assert.equal(badType.statusCode, 400);

    // list includes the created one
    const list = await app.inject({ method: 'GET', url: '/api/v1/payment-methods', headers: auth() });
    assert.ok((list.json() as { id: number }[]).some((m) => m.id === rec.id));

    // toggle inactive
    const t = await app.inject({
      method: 'PATCH', url: `/api/v1/payment-methods/${rec.id}`, headers: auth(),
      payload: { isActive: false },
    });
    assert.equal((t.json() as { isActive: boolean }).isActive, false);

    // edit type+details together
    const e = await app.inject({
      method: 'PATCH', url: `/api/v1/payment-methods/${rec.id}`, headers: auth(),
      payload: { type: 'zelle', details: { email: 'pagos@edv.com', holder: 'EDV' } },
    });
    assert.equal((e.json() as { type: string }).type, 'zelle');

    // changing details without the type is rejected
    const half = await app.inject({
      method: 'PATCH', url: `/api/v1/payment-methods/${rec.id}`, headers: auth(),
      payload: { details: { email: 'x@y.com' } },
    });
    assert.equal(half.statusCode, 400);

    // delete
    const d = await app.inject({ method: 'DELETE', url: `/api/v1/payment-methods/${rec.id}`, headers: auth() });
    assert.equal(d.statusCode, 204);
    created.pop();
  } finally {
    for (const id of created) {
      await app.inject({ method: 'DELETE', url: `/api/v1/payment-methods/${id}`, headers: auth() });
    }
  }
});
