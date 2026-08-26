import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { LocationsRepository } from '../src/modules/locations/locations.repository.js';
import { LocationsService } from '../src/modules/locations/locations.service.js';
import { CAN_OPERATE_STATUSES } from '../src/modules/driver-auth/driver-auth.service.js';
import { removeDriver } from './helpers/db-fixtures.js';

/**
 * Location reporting (proposal: docs/proposals/ubicacion-afiliados).
 *
 * Every test builds its OWN driver and deletes it afterwards, so nothing here
 * touches a real affiliate's history — the database is shared with production.
 *
 * Nothing in this file goes near the debt engine, so unlike the billing suite it
 * cannot emit a charge to anyone.
 */

let pool: pg.Pool;
let app: FastifyInstance;
let repo: LocationsRepository;
let service: LocationsService;

// Caracas, roughly. Any two distinguishable points would do.
const LAT = 10.4806;
const LON = -66.9036;

const ago = (ms: number): Date => new Date(Date.now() - ms);

before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  app = {
    db: pool,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    httpErrors: {
      forbidden: (m: string) => Object.assign(new Error(m), { statusCode: 403 }),
    },
  } as unknown as FastifyInstance;
  repo = new LocationsRepository(pool);
  service = new LocationsService(app, repo);
});

after(async () => {
  await pool.end();
});

/** A driver who may report: operating status, tariff started, available. */
async function makeWorkingDriver(tag: string, overrides = ''): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name)
     VALUES ('TEST', $1, $2) RETURNING id`,
    [tag, `TEST ${tag}`],
  );
  const driverId = rows[0]!.id;
  await pool.query(
    `INSERT INTO drivers (user_id, source, status, is_available, tariff_start_set_at)
     VALUES ($1, 'admin', 'approved', true, now()) ${overrides}`,
    [driverId],
  );
  return driverId;
}

test('a batch lands in one go and moves the last known position', async () => {
  const driverId = await makeWorkingDriver('LocBatch');
  try {
    const stored = await repo.insertBatch(driverId, [
      { lat: LAT, lon: LON, accuracyM: 10, recordedAt: ago(20 * 60 * 1000) },
      { lat: LAT + 0.02, lon: LON + 0.02, accuracyM: 5, recordedAt: ago(0) },
    ]);
    assert.equal(stored, 2);

    const { rows } = await pool.query<{ lat: string; total: number }>(
      `SELECT ST_Y(d.last_location::geometry)::text AS lat,
              (SELECT count(*)::int FROM driver_locations WHERE driver_id = d.user_id) AS total
         FROM drivers d WHERE d.user_id = $1`,
      [driverId],
    );
    assert.equal(rows[0]!.total, 2);
    assert.ok(
      Math.abs(Number(rows[0]!.lat) - (LAT + 0.02)) < 0.0001,
      'la última posición debe ser la del punto más reciente del lote',
    );
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('a stale point is stored but does NOT drag the live position backwards', async () => {
  const driverId = await makeWorkingDriver('LocStale');
  try {
    await repo.insertBatch(driverId, [{ lat: LAT, lon: LON, accuracyM: 5, recordedAt: ago(0) }]);
    // What a queue flush looks like: a point taken hours ago arriving now.
    await repo.insertBatch(driverId, [
      { lat: LAT - 0.5, lon: LON - 0.5, accuracyM: 5, recordedAt: ago(6 * 60 * 60 * 1000) },
    ]);

    const { rows } = await pool.query<{ lat: string; total: number }>(
      `SELECT ST_Y(d.last_location::geometry)::text AS lat,
              (SELECT count(*)::int FROM driver_locations WHERE driver_id = d.user_id) AS total
         FROM drivers d WHERE d.user_id = $1`,
      [driverId],
    );
    assert.equal(rows[0]!.total, 2, 'el punto viejo SÍ se guarda: es parte del recorrido');
    assert.ok(
      Math.abs(Number(rows[0]!.lat) - LAT) < 0.0001,
      'la última posición conocida no puede retroceder a un punto más viejo',
    );
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('unusable points are dropped without taking the good ones with them', async () => {
  const driverId = await makeWorkingDriver('LocJunk');
  try {
    const result = await service.report(driverId, [
      // (0,0) is the Atlantic: what a phone reports with no fix at all.
      { lat: 0, lon: 0, accuracyM: null, recordedAt: ago(0) },
      // Beyond the backdating window.
      { lat: LAT, lon: LON, accuracyM: null, recordedAt: ago(48 * 60 * 60 * 1000) },
      // Far enough ahead to be a forgery rather than clock drift.
      { lat: LAT, lon: LON, accuracyM: null, recordedAt: new Date(Date.now() + 60 * 60 * 1000) },
      { lat: LAT, lon: LON, accuracyM: 8, recordedAt: ago(60 * 1000) },
    ]);

    assert.equal(result.accepted, 1);
    assert.equal(result.rejected, 3);
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('a point a few seconds ahead is clock drift, not a forgery', async () => {
  const driverId = await makeWorkingDriver('LocSkew');
  try {
    const result = await service.report(driverId, [
      { lat: LAT, lon: LON, accuracyM: 8, recordedAt: new Date(Date.now() + 40 * 1000) },
    ]);
    // Rejecting these would silently discard every point from a handful of phones.
    assert.equal(result.accepted, 1);
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('who may report: inactive, not started and penalized are all refused', async () => {
  const inactive = await makeWorkingDriver('LocOff');
  const notStarted = await makeWorkingDriver('LocNoTariff');
  const penalized = await makeWorkingDriver('LocPenalized');
  try {
    await pool.query(`UPDATE drivers SET is_available = false WHERE user_id = $1`, [inactive]);
    await pool.query(`UPDATE drivers SET tariff_start_set_at = NULL WHERE user_id = $1`, [notStarted]);
    await pool.query(`UPDATE drivers SET status = 'penalized' WHERE user_id = $1`, [penalized]);

    for (const [id, label] of [
      [inactive, 'inactivo'],
      [notStarted, 'sin tarifa arrancada'],
      [penalized, 'penalizado'],
    ] as const) {
      const check = await repo.checkEligibility(id, CAN_OPERATE_STATUSES);
      assert.equal(check.allowed, false, `un chofer ${label} no debería poder reportar`);
      assert.ok(check.reason, 'el motivo se le muestra al chofer y apaga el servicio');
    }
  } finally {
    await removeDriver(pool, inactive);
    await removeDriver(pool, notStarted);
    await removeDriver(pool, penalized);
  }
});

test('a driver in arrears DOES report: he owes weeks but still works', async () => {
  const driverId = await makeWorkingDriver('LocOverdue');
  try {
    await pool.query(`UPDATE drivers SET status = 'overdue' WHERE user_id = $1`, [driverId]);
    const check = await repo.checkEligibility(driverId, CAN_OPERATE_STATUSES);
    assert.equal(check.allowed, true, 'overdue opera, así que tiene que seguir en el mapa');
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('the purge drops what is past the window and keeps the rest', async () => {
  const driverId = await makeWorkingDriver('LocPurge');
  try {
    await repo.insertBatch(driverId, [{ lat: LAT, lon: LON, accuracyM: 5, recordedAt: ago(0) }]);
    // Backdated directly: the service would refuse a 40-day-old point on the way in.
    await pool.query(
      `INSERT INTO driver_locations (driver_id, point, recorded_at)
       VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, now() - interval '40 days')`,
      [driverId, LON, LAT],
    );

    const before = await countPoints(driverId);
    assert.equal(before, 2);

    await repo.purgeOlderThan(30);

    const after = await countPoints(driverId);
    assert.equal(after, 1, 'lo anterior a la ventana se va, lo de hoy se queda');
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('the interval is read from settings and nonsense falls back to the default', async () => {
  const original = await service.intervalSeconds();
  try {
    await pool.query(`UPDATE app_settings SET value = '120' WHERE key = 'location_interval_seconds'`);
    assert.equal(await service.intervalSeconds(), 120);

    // A stray value must not turn into a phone hammering the API every second.
    await pool.query(`UPDATE app_settings SET value = '0' WHERE key = 'location_interval_seconds'`);
    assert.equal(await service.intervalSeconds(), 600);
  } finally {
    await pool.query(`UPDATE app_settings SET value = $1 WHERE key = 'location_interval_seconds'`, [
      String(original),
    ]);
  }
});

async function countPoints(driverId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM driver_locations WHERE driver_id = $1`,
    [driverId],
  );
  return rows[0]!.n;
}
