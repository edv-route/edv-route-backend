import type pg from 'pg';

/**
 * Reading side of the location domain (proposal:
 * docs/proposals/ubicacion-afiliados/fase-4-mapa.md). Kept apart from
 * `LocationsRepository`, which is the write path the app hits every ten
 * minutes: nothing here may slow that down or share its transaction.
 *
 * ⚠️ Coordinates cannot be derived from the generated models. Kanel has no
 * mapping for PostGIS `geography`, so `Drivers.last_location` and
 * `DriverLocations.point` come out as `unknown`. The projections below are
 * declared by hand on purpose. Reading a point is `::geometry` first, then
 * ST_Y for latitude and ST_X for longitude — note the order flips against the
 * write path, which builds `ST_MakePoint(lon, lat)`.
 */

/** One affiliate as the live map shows him: his last known position. */
export interface LiveLocationRow {
  userId: string;
  fullName: string;
  nationalId: string | null;
  photoUrl: string | null;
  status: string;
  lat: number;
  lon: number;
  /** Error margin of THAT point, or null when the phone did not report it. */
  accuracyM: number | null;
  lastLocationAt: Date;
}

/** One point of a day's trail. */
export interface HistoryPointRow {
  lat: number;
  lon: number;
  accuracyM: number | null;
  /** When the PHONE took it. The trail is drawn in this order. */
  recordedAt: Date;
  /** When it reached the server. */
  createdAt: Date;
  /** How long it sat in the phone's queue. Zero-ish means live; hours means no signal. */
  delaySeconds: number;
}

export interface HistorySummaryRow {
  count: number;
  firstAt: Date | null;
  lastAt: Date | null;
  /** Worst queue delay of the range, which is what "was out of signal" means. */
  maxDelaySeconds: number | null;
}

export class LocationsReadRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Everyone who is working right now, with their last known position.
   *
   * Reads `drivers.last_location` rather than the history: the map asks "where
   * is each one NOW", and answering that from `driver_locations` means digging
   * the newest row per driver out of tens of thousands, on every refresh.
   *
   * The eligibility filter mirrors the write path exactly (operating status +
   * tariff started + available). If the two ever drift, the map would show
   * people who cannot legally report, or hide people who are reporting.
   *
   * `maxAgeDays` is the retention window, and it is NOT decoration: the purge
   * deletes history but never clears `drivers.last_location`, so an affiliate
   * who stopped working months ago keeps a last position forever. Without this
   * cut-off the map would slowly fill with ghosts. Do not remove it.
   */
  /** Defensive ceiling. Far above any realistic fleet, but not unbounded. */
  private static readonly MAX_LIVE = 1000;

  async listLive(opts: {
    canOperateStatuses: readonly string[];
    maxAgeDays: number;
    /** Optional ceiling in metres. Points with no reported accuracy always pass. */
    maxAccuracyM?: number;
    /** Only rows that moved after this instant, for incremental refreshes. */
    since?: Date;
  }): Promise<LiveLocationRow[]> {
    const values: unknown[] = [opts.canOperateStatuses, opts.maxAgeDays];
    const where: string[] = [
      'd.last_location IS NOT NULL',
      'd.last_location_at IS NOT NULL',
      'd.status::text = ANY($1)',
      'd.tariff_start_set_at IS NOT NULL',
      'd.is_available',
      'd.last_location_at >= now() - make_interval(days => $2::int)',
    ];

    if (opts.since !== undefined) {
      values.push(opts.since);
      where.push(`d.last_location_at > $${values.length}`);
    }

    // The accuracy of the CURRENT point, matched by its timestamp. Null when
    // that row has already been purged, which is why the filter below lets
    // nulls through: unknown accuracy is not the same as bad accuracy.
    const accuracySql = `(SELECT dl.accuracy_m
                            FROM driver_locations dl
                           WHERE dl.driver_id = d.user_id
                             AND dl.recorded_at = d.last_location_at
                           LIMIT 1)`;

    if (opts.maxAccuracyM !== undefined) {
      values.push(opts.maxAccuracyM);
      where.push(`(${accuracySql} IS NULL OR ${accuracySql} <= $${values.length})`);
    }

    values.push(LocationsReadRepository.MAX_LIVE);
    const { rows } = await this.db.query<LiveLocationRow>(
      `SELECT d.user_id AS "userId",
              u.full_name AS "fullName",
              d.national_id AS "nationalId",
              u.photo_url AS "photoUrl",
              d.status::text AS status,
              ST_Y(d.last_location::geometry) AS lat,
              ST_X(d.last_location::geometry) AS lon,
              ${accuracySql} AS "accuracyM",
              d.last_location_at AS "lastLocationAt"
         FROM drivers d
         JOIN users u ON u.id = d.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY d.last_location_at DESC, d.user_id
        LIMIT $${values.length}`,
      values,
    );
    return rows;
  }

  /** Does this affiliate exist? Used to tell "no points that day" from "no such driver". */
  async driverExists(driverId: string): Promise<boolean> {
    const { rows } = await this.db.query(`SELECT 1 FROM drivers WHERE user_id = $1`, [driverId]);
    return rows.length > 0;
  }

  /**
   * The trail of one affiliate between two instants, oldest first — the order
   * it gets drawn in. Served by `driver_locations_driver_recent_idx`.
   *
   * `limit` is a hard ceiling with the real count reported separately: a day is
   * 144 points at the current ten-minute pace, but the day Viajes lowers the
   * interval to a minute it becomes 1440, and an unbounded response would be
   * the panel's problem, not the query's.
   */
  async history(driverId: string, from: Date, to: Date, limit: number): Promise<HistoryPointRow[]> {
    const { rows } = await this.db.query<HistoryPointRow>(
      `SELECT ST_Y(point::geometry) AS lat,
              ST_X(point::geometry) AS lon,
              accuracy_m AS "accuracyM",
              recorded_at AS "recordedAt",
              created_at AS "createdAt",
              GREATEST(0, EXTRACT(EPOCH FROM (created_at - recorded_at)))::int AS "delaySeconds"
         FROM driver_locations
        WHERE driver_id = $1 AND recorded_at >= $2 AND recorded_at <= $3
        ORDER BY recorded_at ASC
        LIMIT $4`,
      [driverId, from, to, limit],
    );
    return rows;
  }

  /**
   * Totals for the same range, asked separately so the summary stays true even
   * when the point list is truncated by `limit`.
   */
  async historySummary(driverId: string, from: Date, to: Date): Promise<HistorySummaryRow> {
    const { rows } = await this.db.query<HistorySummaryRow>(
      `SELECT count(*)::int AS count,
              min(recorded_at) AS "firstAt",
              max(recorded_at) AS "lastAt",
              max(GREATEST(0, EXTRACT(EPOCH FROM (created_at - recorded_at))))::int AS "maxDelaySeconds"
         FROM driver_locations
        WHERE driver_id = $1 AND recorded_at >= $2 AND recorded_at <= $3`,
      [driverId, from, to],
    );
    return rows[0] ?? { count: 0, firstAt: null, lastAt: null, maxDelaySeconds: null };
  }
}
