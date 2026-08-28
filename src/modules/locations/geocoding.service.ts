import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Turns coordinates into a street name (proposal:
 * docs/proposals/ubicacion-afiliados/fase-4-mapa.md, fase 4d).
 *
 * Everything here exists because of one hard constraint: the public
 * OpenStreetMap geocoder allows **one request per second**, requires an
 * identifying User-Agent, and its usage policy explicitly demands that results
 * be cached. A panel that geocoded every affiliate on every refresh would need
 * seven per second and would be blocked — correctly.
 *
 * So: on demand only (when an admin opens somebody's card), cached in the
 * database by grid cell, and serialised behind a one-per-second queue.
 */

/**
 * Size of the cache grid, in degrees. ~33 m at the equator, which is the scale
 * at which a street name stops changing. An affiliate parked at a light emits
 * dozens of readings metres apart; they all collapse into one lookup.
 */
const GRID_DEGREES = 0.0003;

/** The policy limit is 1 req/s. The extra 200 ms is margin, not politeness. */
const MIN_GAP_MS = 1200;

/** Beyond this the request is abandoned rather than left hanging the caller. */
const TIMEOUT_MS = 5000;

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';

/**
 * Zoom 18 is street level. Asking for more detail returns house numbers that
 * OSM rarely has in Venezuela, and returning a wrong number is worse than
 * returning none.
 */
const ZOOM = 18;

interface NominatimAddress {
  road?: string;
  pedestrian?: string;
  suburb?: string;
  neighbourhood?: string;
  city_district?: string;
  town?: string;
  city?: string;
  state?: string;
}

interface NominatimResponse {
  address?: NominatimAddress;
  display_name?: string;
}

export class GeocodingService {
  /** Serialises every outbound call: the rate limit is per client, not per map. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(
    private readonly db: pg.Pool,
    private readonly log: FastifyBaseLogger,
    /** Identifies this application to the geocoder, as its policy requires. */
    private readonly userAgent: string,
  ) {}

  /**
   * Street name for a coordinate, or null when there is nothing to name.
   *
   * A cached null is a real answer and is kept: the middle of a field has no
   * street, and without storing that we would ask again forever.
   */
  async describe(lat: number, lon: number): Promise<string | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const key = gridKey(lat, lon);
    // Also the eight neighbouring cells. Two readings five metres apart can
    // straddle a cell boundary, and asking the geocoder again for what is
    // literally the same street corner is the one thing the cache exists to
    // prevent. Still a single indexed lookup by primary key.
    const cached = await this.db.query<{ grid_key: string; label: string | null }>(
      'SELECT grid_key, label FROM geocode_cache WHERE grid_key = ANY($1)',
      [neighbourKeys(lat, lon)],
    );
    const exact = cached.rows.find((r) => r.grid_key === key);
    if (exact) return exact.label;
    // A neighbour that actually resolved to something is good enough; a
    // neighbouring null is not, because the next cell along may have a name.
    const named = cached.rows.find((r) => r.label !== null);
    if (named) return named.label;

    const centre = gridCentre(lat, lon);
    const label = await this.enqueue(() => this.fetchLabel(centre.lat, centre.lon));

    // Stored even when null, and ON CONFLICT because two admins can open the
    // same affiliate at the same time.
    await this.db.query(
      `INSERT INTO geocode_cache (grid_key, lat, lon, label)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (grid_key) DO NOTHING`,
      [key, centre.lat, centre.lon, label],
    );
    return label;
  }

  /** One call at a time, never faster than the policy allows. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = Math.max(0, this.lastCallAt + MIN_GAP_MS - Date.now());
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastCallAt = Date.now();
      return task();
    });
    // The chain must survive a failure, or one error would jam every later call.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fetchLabel(lat: number, lon: number): Promise<string | null> {
    const url = `${ENDPOINT}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=${ZOOM}&addressdetails=1`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': this.userAgent, 'Accept-Language': 'es' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        this.log.warn({ status: res.status }, 'geocoding: respuesta no OK');
        return null;
      }
      const body = (await res.json()) as NominatimResponse;
      return shortLabel(body);
    } catch (err) {
      // Never fatal: a card without a street name is worth far more than a
      // card that fails to open because a third party was slow.
      this.log.warn({ err }, 'geocoding: fallo al consultar');
      return null;
    }
  }
}

/** "10.2676,-68.0244" snapped to the grid, as a stable text key. */
export function gridKey(lat: number, lon: number): string {
  return `${Math.round(lat / GRID_DEGREES)}:${Math.round(lon / GRID_DEGREES)}`;
}

/** The cell plus its eight neighbours, to survive boundary straddling. */
export function neighbourKeys(lat: number, lon: number): string[] {
  const y = Math.round(lat / GRID_DEGREES);
  const x = Math.round(lon / GRID_DEGREES);
  const keys: string[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) keys.push(`${y + dy}:${x + dx}`);
  }
  return keys;
}

/** Centre of the cell a coordinate falls in — what actually gets geocoded. */
function gridCentre(lat: number, lon: number): { lat: number; lon: number } {
  return {
    lat: Math.round(lat / GRID_DEGREES) * GRID_DEGREES,
    lon: Math.round(lon / GRID_DEGREES) * GRID_DEGREES,
  };
}

/**
 * "Av. Luis Roche, Altamira" rather than the full postal string.
 *
 * The raw `display_name` is a comma-separated wall ending in "Venezuela": on a
 * card that is noise. Street plus neighbourhood is what an operator needs to
 * place somebody at a glance.
 */
function shortLabel(body: NominatimResponse): string | null {
  const a = body.address;
  if (!a) return body.display_name ?? null;

  const street = a.road ?? a.pedestrian ?? null;
  const area = a.suburb ?? a.neighbourhood ?? a.city_district ?? a.town ?? a.city ?? null;

  if (street && area) return `${street}, ${area}`;
  if (street) return street;
  if (area) return area;
  return a.state ?? null;
}
