import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { LocationsRepository } from '../src/modules/locations/locations.repository.js';
import { LocationsReadRepository } from '../src/modules/locations/locations.read.repository.js';
import { LocationsAdminService } from '../src/modules/locations/locations.admin.service.js';
import { removeDriver } from './helpers/db-fixtures.js';

/**
 * The reading side: what the panel's map and trails are built on (proposal:
 * docs/proposals/ubicacion-afiliados/fase-4-mapa.md).
 *
 * Same discipline as locations.test.ts — every test builds its OWN driver and
 * deletes it afterwards, because the database is shared with production. The
 * live listing is always filtered down to this run's drivers before asserting,
 * so a real affiliate out working right now cannot turn the suite red.
 *
 * Nothing here goes near the debt engine, so it cannot charge anyone.
 */

let pool: pg.Pool;
let app: FastifyInstance;
let writeRepo: LocationsRepository;
let readRepo: LocationsReadRepository;
let service: LocationsAdminService;
/** A real admin id: audit_logs.actor_admin_id is a foreign key. */
let adminId: string | null = null;

const LAT = 10.4806;
const LON = -66.9036;

const minutes = (n: number): number => n * 60 * 1000;
const days = (n: number): number => n * 24 * 60 * minutes(1);
const ago = (ms: number): Date => new Date(Date.now() - ms);

before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  app = {
    db: pool,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    httpErrors: {
      badRequest: (m: string) => Object.assign(new Error(m), { statusCode: 400 }),
      notFound: (m: string) => Object.assign(new Error(m), { statusCode: 404 }),
      forbidden: (m: string) => Object.assign(new Error(m), { statusCode: 403 }),
    },
    // No storage in tests: signAvatars falls back to null, which is the same
    // path a broken bucket takes in production.
    storage: undefined,
  } as unknown as FastifyInstance;
  writeRepo = new LocationsRepository(pool);
  readRepo = new LocationsReadRepository(pool);
  service = new LocationsAdminService(app, readRepo);

  const { rows } = await pool.query<{ id: string }>('SELECT id FROM admins LIMIT 1');
  adminId = rows[0]?.id ?? null;
});

after(async () => {
  await pool.end();
});

async function makeWorkingDriver(tag: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (first_name, last_name, full_name)
     VALUES ('TEST', $1, $2) RETURNING id`,
    [tag, `TEST ${tag}`],
  );
  const driverId = rows[0]!.id;
  await pool.query(
    `INSERT INTO drivers (user_id, source, status, is_available, tariff_start_set_at)
     VALUES ($1, 'admin', 'approved', true, now())`,
    [driverId],
  );
  return driverId;
}

/** Places a driver on the map directly, bypassing the 24 h backdating rule. */
async function placeAt(driverId: string, at: Date, lat = LAT, lon = LON): Promise<void> {
  await pool.query(
    `UPDATE drivers
        SET last_location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
            last_location_at = $4
      WHERE user_id = $1`,
    [driverId, lon, lat, at],
  );
}

test('the live map shows only who is actually working', async () => {
  const working = await makeWorkingDriver('MapWorking');
  const inactive = await makeWorkingDriver('MapInactive');
  const noTariff = await makeWorkingDriver('MapNoTariff');
  const penalized = await makeWorkingDriver('MapPenalized');
  const overdue = await makeWorkingDriver('MapOverdue');
  const ids = [working, inactive, noTariff, penalized, overdue];
  try {
    for (const id of ids) {
      await writeRepo.insertBatch(id, [{ lat: LAT, lon: LON, accuracyM: 12, recordedAt: ago(0) }]);
    }
    await pool.query('UPDATE drivers SET is_available = false WHERE user_id = $1', [inactive]);
    await pool.query('UPDATE drivers SET tariff_start_set_at = NULL WHERE user_id = $1', [noTariff]);
    await pool.query(`UPDATE drivers SET status = 'penalized' WHERE user_id = $1`, [penalized]);
    await pool.query(`UPDATE drivers SET status = 'overdue' WHERE user_id = $1`, [overdue]);

    const { items } = await service.live();
    const mine = new Set(items.filter((i) => ids.includes(i.userId)).map((i) => i.userId));

    assert.ok(mine.has(working), 'un chofer trabajando tiene que salir en el mapa');
    assert.ok(mine.has(overdue), 'un chofer en mora opera, así que sigue en el mapa');
    assert.ok(!mine.has(inactive), 'un chofer inactivo no reporta: no puede salir');
    assert.ok(!mine.has(noTariff), 'sin tarifa arrancada todavía no trabaja');
    assert.ok(!mine.has(penalized), 'un penalizado no opera');
  } finally {
    for (const id of ids) await removeDriver(pool, id);
  }
});

test('the coordinates come back the way they went in', async () => {
  const driverId = await makeWorkingDriver('MapCoords');
  try {
    await writeRepo.insertBatch(driverId, [
      { lat: LAT, lon: LON, accuracyM: 23, recordedAt: ago(0) },
    ]);

    const { items } = await service.live();
    const mine = items.find((i) => i.userId === driverId);
    assert.ok(mine, 'el chofer debería estar en el mapa');
    // ST_X is longitude and ST_Y latitude. Swapping them lands the whole fleet
    // in the Indian Ocean, and nothing else in the code would complain.
    assert.ok(Math.abs(mine.lat - LAT) < 0.0001, 'la latitud no cuadra');
    assert.ok(Math.abs(mine.lon - LON) < 0.0001, 'la longitud no cuadra');
    assert.equal(mine.accuracyM, 23, 'la precisión tiene que ser la de ESE punto');
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('presence is derived from the configured interval, not from fixed minutes', async () => {
  const fresh = await makeWorkingDriver('MapFresh');
  const late = await makeWorkingDriver('MapLate');
  const gone = await makeWorkingDriver('MapGone');
  const ids = [fresh, late, gone];
  try {
    for (const id of ids) {
      await writeRepo.insertBatch(id, [{ lat: LAT, lon: LON, accuracyM: 10, recordedAt: ago(0) }]);
    }

    const first = await service.live();
    assert.equal(first.onlineWithinSeconds, first.intervalSeconds * 2);
    assert.equal(first.delayedWithinSeconds, first.intervalSeconds * 3);

    // Placed relative to the interval in force, so this test keeps meaning the
    // same thing the day Viajes drops the pace to one minute.
    await placeAt(fresh, new Date(Date.now() - (first.onlineWithinSeconds - 60) * 1000));
    await placeAt(late, new Date(Date.now() - (first.onlineWithinSeconds + 60) * 1000));
    await placeAt(gone, new Date(Date.now() - (first.delayedWithinSeconds + 60) * 1000));

    const after = await service.live();
    const presenceOf = (id: string): string | undefined =>
      after.items.find((i) => i.userId === id)?.presence;

    assert.equal(presenceOf(fresh), 'online');
    assert.equal(presenceOf(late), 'delayed');
    assert.equal(
      presenceOf(gone),
      'offline',
      'quien lleva rato sin reportar no puede figurar como presente',
    );
  } finally {
    for (const id of ids) await removeDriver(pool, id);
  }
});

test('a ghost past the retention window is not drawn', async () => {
  const driverId = await makeWorkingDriver('MapGhost');
  try {
    // The purge deletes history but never clears drivers.last_location, so this
    // is exactly what an affiliate who stopped working months ago looks like.
    await placeAt(driverId, ago(days(40)));

    const { items } = await service.live();
    assert.ok(
      !items.some((i) => i.userId === driverId),
      'una última posición de hace 40 días es un fantasma, no un chofer en la calle',
    );
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('the accuracy filter hides bad points but keeps the ones with no reading', async () => {
  const precise = await makeWorkingDriver('MapPrecise');
  const sloppy = await makeWorkingDriver('MapSloppy');
  const unknown = await makeWorkingDriver('MapUnknown');
  const ids = [precise, sloppy, unknown];
  try {
    await writeRepo.insertBatch(precise, [
      { lat: LAT, lon: LON, accuracyM: 20, recordedAt: ago(0) },
    ]);
    await writeRepo.insertBatch(sloppy, [
      { lat: LAT, lon: LON, accuracyM: 480, recordedAt: ago(0) },
    ]);
    await writeRepo.insertBatch(unknown, [
      { lat: LAT, lon: LON, accuracyM: null, recordedAt: ago(0) },
    ]);

    const { items } = await service.live({ maxAccuracyM: 200 });
    const has = (id: string): boolean => items.some((i) => i.userId === id);

    assert.ok(has(precise), '20 m está dentro del filtro');
    assert.ok(!has(sloppy), '480 m es justo lo que el filtro existe para esconder');
    assert.ok(has(unknown), 'precisión desconocida no es lo mismo que precisión mala');
  } finally {
    for (const id of ids) await removeDriver(pool, id);
  }
});

test('since returns only who moved after that instant', async () => {
  const moved = await makeWorkingDriver('MapMoved');
  const still = await makeWorkingDriver('MapStill');
  try {
    await placeAt(still, ago(minutes(30)));
    await placeAt(moved, ago(minutes(1)));

    const { items } = await service.live({ since: ago(minutes(10)) });
    assert.ok(
      items.some((i) => i.userId === moved),
      'quien se movió después de ese instante tiene que venir',
    );
    assert.ok(
      !items.some((i) => i.userId === still),
      'quien no se ha movido no debe viajar otra vez por la red',
    );
  } finally {
    await removeDriver(pool, moved);
    await removeDriver(pool, still);
  }
});

test('the trail comes back oldest first, with the queue delay of each point', async () => {
  const driverId = await makeWorkingDriver('MapTrail');
  try {
    await writeRepo.insertBatch(driverId, [
      { lat: LAT + 0.01, lon: LON + 0.01, accuracyM: 15, recordedAt: ago(minutes(10)) },
      { lat: LAT, lon: LON, accuracyM: 30, recordedAt: ago(minutes(40)) },
    ]);

    const points = await readRepo.history(driverId, ago(minutes(120)), new Date(), 1000);
    assert.equal(points.length, 2);
    assert.ok(
      points[0]!.recordedAt.getTime() < points[1]!.recordedAt.getTime(),
      'el recorrido se dibuja del punto más viejo al más nuevo',
    );
    // Both arrived just now, so the older reading carries the bigger delay:
    // that gap is what marks the stretch the phone held without signal.
    assert.ok(points[0]!.delaySeconds >= points[1]!.delaySeconds);
    assert.ok(points[0]!.delaySeconds >= 0, 'un retraso nunca puede ser negativo');
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('the summary counts the whole range even when the points are capped', async () => {
  const driverId = await makeWorkingDriver('MapSummary');
  try {
    await writeRepo.insertBatch(driverId, [
      { lat: LAT, lon: LON, accuracyM: 10, recordedAt: ago(minutes(30)) },
      { lat: LAT, lon: LON, accuracyM: 10, recordedAt: ago(minutes(20)) },
      { lat: LAT, lon: LON, accuracyM: 10, recordedAt: ago(minutes(10)) },
    ]);

    const summary = await readRepo.historySummary(driverId, ago(minutes(120)), new Date());
    assert.equal(summary.count, 3);
    assert.ok(summary.firstAt && summary.lastAt);
    assert.ok(summary.firstAt.getTime() < summary.lastAt.getTime());

    // A capped read still reports the true total, so the panel can say so.
    const capped = await readRepo.history(driverId, ago(minutes(120)), new Date(), 2);
    assert.equal(capped.length, 2);
    assert.ok(capped.length < summary.count, 'el recorte tiene que ser visible');
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('a nonsense range is refused before touching the table', async () => {
  const driverId = await makeWorkingDriver('MapRange');
  const actor = adminId ?? driverId;
  try {
    await assert.rejects(
      () => service.history(driverId, new Date(), ago(minutes(60)), actor),
      /posterior/,
      'un rango al revés no tiene sentido',
    );
    await assert.rejects(
      () => service.history(driverId, ago(days(90)), new Date(), actor),
      /31 días/,
      'un rango enorme barrería la tabla entera',
    );
  } finally {
    await removeDriver(pool, driverId);
  }
});

test('asking for the trail of somebody who does not exist is a 404', async () => {
  const nobody = '00000000-0000-0000-0000-000000000000';
  await assert.rejects(
    () => service.history(nobody, ago(minutes(60)), new Date(), adminId ?? nobody),
    /no encontrado/i,
  );
});

test('looking up where somebody was leaves a trace', async (t) => {
  if (!adminId) {
    t.skip('no hay ningún admin en la base para firmar la auditoría');
    return;
  }
  const driverId = await makeWorkingDriver('MapAudit');
  try {
    await writeRepo.insertBatch(driverId, [
      { lat: LAT, lon: LON, accuracyM: 10, recordedAt: ago(minutes(5)) },
    ]);

    const result = await service.history(driverId, ago(minutes(60)), new Date(), adminId);
    assert.equal(result.summary.count, 1);
    assert.equal(result.truncated, false);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_logs
        WHERE event_type = 'driver.location_history_viewed' AND entity_id = $1`,
      [driverId],
    );
    // Where a person was on a given day is not an ordinary listing: consulting
    // it has to be as traceable as touching their money.
    assert.equal(
      Number(rows[0]!.count),
      1,
      'consultar el recorrido de alguien tiene que dejar rastro',
    );
  } finally {
    await pool.query(
      `DELETE FROM audit_logs WHERE event_type = 'driver.location_history_viewed' AND entity_id = $1`,
      [driverId],
    );
    await removeDriver(pool, driverId);
  }
});
