import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { removeDriver as removeDriverFixture } from './helpers/db-fixtures.js';

/**
 * Where the notices are BORN. Phase 1 proved the outbox; this proves the events
 * actually reach it, through the real endpoints, and that each one carries what
 * the affiliate needs to act on (above all: the reason of a rejection).
 *
 * The verdicts run in a transaction with their notice, so what is asserted is
 * always the pair — never the notice alone.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let token: string;

before(async () => {
  app = await buildApp();
  await app.ready();
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
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

interface Notice {
  type: string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  deliverAfter: Date;
  pushStatus: string;
}

async function notices(driverId: string, type?: string): Promise<Notice[]> {
  const { rows } = await pool.query<Notice>(
    `SELECT type, title, body, payload, deliver_after AS "deliverAfter",
            push_status AS "pushStatus"
       FROM notifications
      WHERE user_id = $1 ${type ? 'AND type = $2' : ''}
      ORDER BY id`,
    type ? [driverId, type] : [driverId],
  );
  return rows;
}

/** Registers a driver WITHOUT payment, so the alta emits its debt. */
async function newDriverWithDebt(nationalId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/drivers/register',
    headers: auth(),
    payload: {
      firstName: 'TEST',
      lastName: 'Aviso',
      nationalId,
      payment: null,
      vehicles: [],
      documents: [],
    },
  });
  return (res.json() as { userId: string }).userId;
}

async function createMethod(): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/payment-methods',
    headers: auth(),
    payload: {
      name: 'TEST Zelle avisos',
      type: 'zelle',
      details: { email: 'avisos@test.com', holder: 'EDV' },
    },
  });
  return (res.json() as { id: number }).id;
}

async function insertPending(
  driverId: string,
  amountUsd: string,
  methodId: number,
  reference: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO payment_submissions
       (driver_id, amount_usd, payment_method_id, payment_reference, source, status)
     VALUES ($1, $2, $3, $4, 'admin', 'pending') RETURNING id`,
    [driverId, amountUsd, methodId, reference],
  );
  return rows[0]!.id;
}

test('rejecting a payment tells the affiliate, WITH the reason', async () => {
  const driverId = await newDriverWithDebt('V-31900101');
  try {
    const methodId = await createMethod();
    const submissionId = await insertPending(driverId, '70.00', methodId, 'AVISO-REJ');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/payment-submissions/${submissionId}/reject`,
      headers: auth(),
      payload: { reason: 'El comprobante no es legible' },
    });
    assert.equal(res.statusCode, 204, res.payload);

    const [notice, ...rest] = await notices(driverId, 'payment_rejected');
    assert.ok(notice, 'el rechazo debe dejar un aviso: era el bug que originó todo esto');
    assert.equal(rest.length, 0, 'uno solo, no uno por intento');
    assert.match(notice.body, /El comprobante no es legible/, 'el motivo va en el texto');
    assert.match(notice.body, /\$70,00/, 'y el monto, para que sepa cuál de sus pagos es');
    assert.equal(
      (notice.payload as { reason: string }).reason,
      'El comprobante no es legible',
      'el motivo también estructurado, para que la app pueda mostrarlo aparte',
    );
  } finally {
    await removeDriver(driverId);
  }
});

test('a rejection that does not happen leaves no notice', async () => {
  const driverId = await newDriverWithDebt('V-31900102');
  try {
    const methodId = await createMethod();
    const submissionId = await insertPending(driverId, '70.00', methodId, 'AVISO-REJ2');

    const url = `/api/v1/payment-submissions/${submissionId}/reject`;
    await app.inject({ method: 'POST', url, headers: auth(), payload: { reason: 'Primera vez' } });
    const second = await app.inject({
      method: 'POST',
      url,
      headers: auth(),
      payload: { reason: 'Segunda vez' },
    });
    assert.ok(second.statusCode >= 400, 'no se puede rechazar dos veces');

    assert.equal(
      (await notices(driverId, 'payment_rejected')).length,
      1,
      'el aviso viaja con el veredicto: sin veredicto, sin aviso',
    );
  } finally {
    await removeDriver(driverId);
  }
});

test('approving a payment tells him, and cancels the reminder he no longer needs', async () => {
  const driverId = await newDriverWithDebt('V-31900103');
  try {
    const methodId = await createMethod();
    const { rows: debt } = await pool.query<{ total: string }>(
      `SELECT COALESCE(sum(total_usd), 0)::text AS total FROM invoices
        WHERE driver_id = $1 AND status = 'issued'`,
      [driverId],
    );
    const submissionId = await insertPending(driverId, debt[0]!.total, methodId, 'AVISO-APR');

    // The heads-up the engine schedules for the week he is about to pay.
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, deliver_after)
       VALUES ($1, 'charge_reminder', 'Tu semana empieza mañana', 'Recordatorio',
               now() + interval '2 days')`,
      [driverId],
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/payment-submissions/${submissionId}/approve`,
      headers: auth(),
    });
    assert.equal(res.statusCode, 200, res.payload);

    const approved = await notices(driverId, 'payment_approved');
    assert.equal(approved.length, 1);
    assert.match(approved[0]!.title, /aprobado/i);

    assert.equal(
      (await notices(driverId, 'charge_reminder')).length,
      0,
      'recordarle que pague lo que acaba de pagar es el ruido que hace que la gente silencie los avisos',
    );
  } finally {
    await removeDriver(driverId);
  }
});

test('a delivered reminder is history and survives the payment', async () => {
  const driverId = await newDriverWithDebt('V-31900104');
  try {
    const methodId = await createMethod();
    const { rows: debt } = await pool.query<{ total: string }>(
      `SELECT COALESCE(sum(total_usd), 0)::text AS total FROM invoices
        WHERE driver_id = $1 AND status = 'issued'`,
      [driverId],
    );
    const submissionId = await insertPending(driverId, debt[0]!.total, methodId, 'AVISO-APR2');

    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, deliver_after, push_status, push_sent_at)
       VALUES ($1, 'charge_reminder', 'Tu semana empieza mañana', 'Recordatorio',
               now() - interval '1 day', 'sent', now())`,
      [driverId],
    );

    await app.inject({
      method: 'POST',
      url: `/api/v1/payment-submissions/${submissionId}/approve`,
      headers: auth(),
    });

    assert.equal(
      (await notices(driverId, 'charge_reminder')).length,
      1,
      'lo que ya se le envió no se borra de su bandeja: sería reescribirle el historial',
    );
  } finally {
    await removeDriver(driverId);
  }
});

test('reviewing a document names the document and gives the reason', async () => {
  const driverId = await newDriverWithDebt('V-31900105');
  try {
    const { rows: req } = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM requirements WHERE applies_to = 'driver' AND active ORDER BY id LIMIT 1`,
    );
    const requirement = req[0];
    assert.ok(requirement, 'la base necesita al menos un requisito de chofer activo');

    const { rows: doc } = await pool.query<{ id: string }>(
      `INSERT INTO documents (requirement_id, driver_id, approval_status)
       VALUES ($1, $2, 'pending') RETURNING id`,
      [requirement.id, driverId],
    );
    const documentId = doc[0]!.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/reject`,
      headers: auth(),
      payload: { reason: 'La foto está borrosa' },
    });
    assert.equal(res.statusCode, 200, res.payload);

    const [notice] = await notices(driverId, 'document_rejected');
    assert.ok(notice);
    assert.match(
      notice.body,
      new RegExp(requirement.name, 'i'),
      'tiene que decir CUÁL documento: un afiliado puede tener varios rechazados',
    );
    assert.match(notice.body, /La foto está borrosa/);
  } finally {
    await removeDriver(driverId);
  }
});

test('approving a vehicle names its plate', async () => {
  const driverId = await newDriverWithDebt('V-31900106');
  try {
    const { rows: veh } = await pool.query<{ id: string }>(
      `INSERT INTO vehicles (driver_id, plate, approval_status)
       VALUES ($1, 'TSTAV01', 'pending') RETURNING id`,
      [driverId],
    );
    const vehicleId = veh[0]!.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/drivers/${driverId}/vehicles/${vehicleId}/approve`,
      headers: auth(),
    });
    assert.equal(res.statusCode, 200, res.payload);

    const [notice] = await notices(driverId, 'vehicle_approved');
    assert.ok(notice, 'el veredicto del vehículo debe avisarle');
    assert.match(notice.body, /TSTAV01/);

    // Same transaction: the only approved vehicle is also put in use, so the
    // message "ya puedes trabajar con él" is true when he opens the app.
    const { rows: driver } = await pool.query<{ currentVehicleId: string | null }>(
      `SELECT current_vehicle_id AS "currentVehicleId" FROM drivers WHERE user_id = $1`,
      [driverId],
    );
    assert.equal(driver[0]!.currentVehicleId, vehicleId);
  } finally {
    await pool.query(`DELETE FROM vehicles WHERE driver_id = $1`, [driverId]);
    await removeDriver(driverId);
  }
});
