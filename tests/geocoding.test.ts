import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { GeocodingService, gridKey, neighbourKeys } from '../src/modules/locations/geocoding.service.js';

/**
 * Reverse geocoding cache (proposal:
 * docs/proposals/ubicacion-afiliados/fase-4-mapa.md, fase 4d).
 *
 * Nothing here touches the network. The public geocoder allows one request per
 * second, so a suite that called it would be both slow and rude — and would
 * fail whenever OpenStreetMap is having a bad day. What matters is the part we
 * wrote: the grid, the neighbour lookup, and that a cached answer never leaves
 * the database.
 *
 * The rows created use a coordinate in the middle of the ocean, so they cannot
 * collide with anything a real affiliate produced.
 */

let pool: pg.Pool;

/** Deliberately far from anywhere the fleet works. */
const LAT = -40.123456;
const LON = -120.987654;

const silentLog = {
  warn: () => {},
  info: () => {},
  error: () => {},
} as unknown as Parameters<typeof GeocodingService.prototype.constructor>[1];

before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
});

after(async () => {
  await pool.query(`DELETE FROM geocode_cache WHERE lat < -35 AND lon < -100`);
  await pool.end();
});

test('the grid collapses nearby readings into the same key', () => {
  // ~11 m apart: a driver stopped at a light, not a driver who moved.
  assert.equal(gridKey(LAT, LON), gridKey(LAT + 0.0001, LON));
  // ~330 m apart: genuinely somewhere else.
  assert.notEqual(gridKey(LAT, LON), gridKey(LAT + 0.003, LON));
});

test('the neighbour lookup covers the cell and the eight around it', () => {
  const keys = neighbourKeys(LAT, LON);
  assert.equal(keys.length, 9);
  assert.ok(keys.includes(gridKey(LAT, LON)), 'la propia celda tiene que estar');
  // A reading right on the boundary must be reachable from the original cell.
  assert.ok(
    keys.includes(gridKey(LAT + 0.0003, LON)),
    'la celda de al lado tiene que estar, o dos lecturas a cinco metros preguntan dos veces',
  );
});

test('a cached answer is served without going to the network', async () => {
  const service = new GeocodingService(pool, silentLog, 'EDVRoute/test');
  const key = gridKey(LAT, LON);
  await pool.query(
    `INSERT INTO geocode_cache (grid_key, lat, lon, label) VALUES ($1, $2, $3, $4)
     ON CONFLICT (grid_key) DO UPDATE SET label = EXCLUDED.label`,
    [key, LAT, LON, 'Calle de Prueba, Barrio Falso'],
  );

  const label = await service.describe(LAT, LON);
  assert.equal(label, 'Calle de Prueba, Barrio Falso');

  // Only one row: a cache hit must never write another.
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM geocode_cache WHERE grid_key = $1`, [key]);
  assert.equal(rows[0]!.n, 1);
});

test('a reading that straddles the cell boundary reuses the neighbour', async () => {
  const service = new GeocodingService(pool, silentLog, 'EDVRoute/test');
  // Its own cell is empty; the neighbour seeded above is not.
  const label = await service.describe(LAT + 0.0003, LON);
  assert.equal(
    label,
    'Calle de Prueba, Barrio Falso',
    'cinco metros no son otra calle: tiene que salir del vecino, sin ir a la red',
  );
});

test('a cached null is an answer, not a miss', async () => {
  const service = new GeocodingService(pool, silentLog, 'EDVRoute/test');
  const lat = LAT + 0.05;
  const key = gridKey(lat, LON);
  await pool.query(
    `INSERT INTO geocode_cache (grid_key, lat, lon, label) VALUES ($1, $2, $3, NULL)
     ON CONFLICT (grid_key) DO UPDATE SET label = NULL`,
    [key, lat, LON],
  );

  const label = await service.describe(lat, LON);
  // The middle of a field has no street. Storing that is what stops us asking
  // the geocoder about it forever.
  assert.equal(label, null);
});
