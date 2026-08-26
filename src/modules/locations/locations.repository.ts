import type pg from 'pg';

/** One position as the phone took it. */
export interface LocationPoint {
  lat: number;
  lon: number;
  /** Margin of error in metres, as the phone reported it. Null if unknown. */
  accuracyM: number | null;
  /** When the PHONE took it — not when it reached us. */
  recordedAt: Date;
}

/** Whether this driver may report at all, and why not when he may not. */
export interface ReportingEligibility {
  allowed: boolean;
  /** Message for the app when `allowed` is false. */
  reason?: string;
}

export class LocationsRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Writes a whole batch in ONE statement via `unnest`, rather than a loop of
   * inserts. The local queue can hand over a dozen points at once when signal
   * comes back, and a round trip per point turns a reconnection into a burst
   * against a pool that only has eight connections in production.
   *
   * The last known position is updated in the same transaction, but only when
   * the newest point in the batch is actually NEWER than what `drivers` already
   * holds: a queue flush can deliver points from an hour ago, and letting those
   * overwrite the live position would move the driver backwards on the map.
   */
  async insertBatch(driverId: string, points: LocationPoint[]): Promise<number> {
    if (points.length === 0) return 0;

    const lons = points.map((p) => p.lon);
    const lats = points.map((p) => p.lat);
    const accuracies = points.map((p) => p.accuracyM);
    const recordedAts = points.map((p) => p.recordedAt);

    const newest = points.reduce((a, b) => (a.recordedAt >= b.recordedAt ? a : b));

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const inserted = await client.query(
        `INSERT INTO driver_locations (driver_id, point, accuracy_m, recorded_at)
         SELECT $1, ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)::geography, t.acc, t.rec
           FROM unnest($2::float8[], $3::float8[], $4::real[], $5::timestamptz[])
                AS t(lon, lat, acc, rec)`,
        [driverId, lons, lats, accuracies, recordedAts],
      );

      await client.query(
        `UPDATE drivers
            SET last_location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
                last_location_at = $4
          WHERE user_id = $1
            AND (last_location_at IS NULL OR last_location_at < $4)`,
        [driverId, newest.lon, newest.lat, newest.recordedAt],
      );

      await client.query('COMMIT');
      return inserted.rowCount ?? 0;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * May this driver report? The rule is the one the rest of the system already
   * uses, asked in a single query so the answer cannot drift from what the
   * availability switch enforces:
   *
   *   - a status that can operate (`approved` or `overdue` — a driver in arrears
   *     still works, and still needs to be on the map)
   *   - the tariff actually started (an approved driver waiting for Monday is
   *     not working yet)
   *   - he put himself available
   *
   * The reason is worded for the driver, because the app shows it and then
   * SHUTS THE SERVICE DOWN — repeating a request every ten minutes against a
   * closed door drains a battery for nothing.
   */
  async checkEligibility(
    driverId: string,
    canOperateStatuses: readonly string[],
  ): Promise<ReportingEligibility> {
    const { rows } = await this.db.query<{
      status: string;
      tariffStarted: boolean;
      isAvailable: boolean;
    }>(
      `SELECT status::text AS status,
              (tariff_start_set_at IS NOT NULL) AS "tariffStarted",
              is_available AS "isAvailable"
         FROM drivers WHERE user_id = $1`,
      [driverId],
    );

    const row = rows[0];
    if (!row) return { allowed: false, reason: 'No se encontró tu perfil' };
    if (!canOperateStatuses.includes(row.status)) {
      return { allowed: false, reason: 'Tu cuenta no está habilitada para trabajar' };
    }
    if (!row.tariffStarted) {
      return { allowed: false, reason: 'Tu tarifa todavía no ha arrancado' };
    }
    if (!row.isAvailable) {
      return { allowed: false, reason: 'Estás inactivo' };
    }
    return { allowed: true };
  }

  /** Drops everything older than `days`. Returns how many rows went. */
  async purgeOlderThan(days: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM driver_locations WHERE recorded_at < now() - make_interval(days => $1::int)`,
      [days],
    );
    return rowCount ?? 0;
  }
}
