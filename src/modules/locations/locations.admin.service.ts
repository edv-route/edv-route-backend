import type { FastifyInstance } from 'fastify';
import { SettingsRepository } from '../settings/settings.repository.js';
import { CAN_OPERATE_STATUSES } from '../driver-auth/driver-auth.service.js';
import { writeAudit } from '../audit-logs/audit-writer.js';
import { readIntervalSeconds, readRetentionDays } from './locations.settings.js';
import type { LocationsReadRepository } from './locations.read.repository.js';

/** Signed-URL lifetime for the avatars on the map. Same as the affiliates list. */
const AVATAR_TTL_SECONDS = 3600;

/**
 * Hard ceiling of points per history response. A day is 144 at the current
 * ten-minute pace; the day Viajes lowers the interval to a minute it is 1440.
 * The real count travels in the summary, so a truncated answer is visibly
 * truncated instead of quietly wrong.
 */
const MAX_HISTORY_POINTS = 1000;

/** Widest range the history endpoint accepts, a bit over the default retention. */
const MAX_HISTORY_DAYS = 31;

/**
 * How present an affiliate is, derived from how long ago he reported.
 *
 * Derived from the configured interval instead of fixed minutes ON PURPOSE:
 * the pace lives in `app_settings` and drops to 30-60 s the day Viajes ships.
 * A hard-coded "20 minutes" would quietly start lying that same day.
 */
export type Presence = 'online' | 'delayed' | 'offline';

const ONLINE_INTERVALS = 2;
const DELAYED_INTERVALS = 3;

export interface LiveLocationItem {
  userId: string;
  fullName: string;
  nationalId: string | null;
  photoUrl: string | null;
  status: string;
  lat: number;
  lon: number;
  accuracyM: number | null;
  lastLocationAt: string;
  /** Seconds since the phone took that position. */
  ageSeconds: number;
  presence: Presence;
}

export interface LiveResult {
  items: LiveLocationItem[];
  total: number;
  /** The pace in force, so the panel can time its refresh without a second call. */
  intervalSeconds: number;
  /** Thresholds the server used, so the legend never contradicts the pins. */
  onlineWithinSeconds: number;
  delayedWithinSeconds: number;
}

export interface HistoryResult {
  points: {
    lat: number;
    lon: number;
    accuracyM: number | null;
    recordedAt: string;
    createdAt: string;
    delaySeconds: number;
  }[];
  summary: {
    count: number;
    firstAt: string | null;
    lastAt: string | null;
    maxDelaySeconds: number | null;
  };
  /** True when `points` holds fewer rows than `summary.count`. */
  truncated: boolean;
}

export class LocationsAdminService {
  private readonly settings: SettingsRepository;

  constructor(
    private readonly app: FastifyInstance,
    private readonly repo: LocationsReadRepository,
  ) {
    this.settings = new SettingsRepository(app.db);
  }

  /** Everyone working right now, ready to pin on a map. */
  async live(opts: { maxAccuracyM?: number; since?: Date } = {}): Promise<LiveResult> {
    const [intervalSeconds, retentionDays] = await Promise.all([
      readIntervalSeconds(this.settings),
      readRetentionDays(this.settings),
    ]);

    const rows = await this.repo.listLive({
      canOperateStatuses: CAN_OPERATE_STATUSES,
      maxAgeDays: retentionDays,
      ...(opts.maxAccuracyM !== undefined ? { maxAccuracyM: opts.maxAccuracyM } : {}),
      ...(opts.since !== undefined ? { since: opts.since } : {}),
    });

    const onlineWithinSeconds = intervalSeconds * ONLINE_INTERVALS;
    const delayedWithinSeconds = intervalSeconds * DELAYED_INTERVALS;
    const now = Date.now();

    const withPhotos = await this.signAvatars(rows);
    const items: LiveLocationItem[] = withPhotos.map((row) => {
      const ageSeconds = Math.max(0, Math.round((now - row.lastLocationAt.getTime()) / 1000));
      return {
        userId: row.userId,
        fullName: row.fullName,
        nationalId: row.nationalId,
        photoUrl: row.photoUrl,
        status: row.status,
        lat: row.lat,
        lon: row.lon,
        accuracyM: row.accuracyM,
        lastLocationAt: row.lastLocationAt.toISOString(),
        ageSeconds,
        presence:
          ageSeconds <= onlineWithinSeconds
            ? 'online'
            : ageSeconds <= delayedWithinSeconds
              ? 'delayed'
              : 'offline',
      };
    });

    return { items, total: items.length, intervalSeconds, onlineWithinSeconds, delayedWithinSeconds };
  }

  /**
   * One affiliate's trail between two instants.
   *
   * The caller sends absolute instants, never a calendar day: whether a day
   * starts in Caracas or in UTC is a question about the user, and the server
   * has no business guessing it.
   *
   * Looking up where one person was on a given day leaves an audit entry. The
   * live map does not — that is a working view, and auditing it would be noise.
   */
  async history(
    driverId: string,
    from: Date,
    to: Date,
    adminId: string,
  ): Promise<HistoryResult> {
    const { httpErrors } = this.app;

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw httpErrors.badRequest('Fechas inválidas');
    }
    if (to <= from) {
      throw httpErrors.badRequest('El final del rango debe ser posterior al inicio');
    }
    if (to.getTime() - from.getTime() > MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000) {
      throw httpErrors.badRequest(`El rango no puede superar ${MAX_HISTORY_DAYS} días`);
    }
    if (!(await this.repo.driverExists(driverId))) {
      throw httpErrors.notFound('Afiliado no encontrado');
    }

    const [rows, summary] = await Promise.all([
      this.repo.history(driverId, from, to, MAX_HISTORY_POINTS),
      this.repo.historySummary(driverId, from, to),
    ]);

    await writeAudit(this.app.db, {
      actorAdminId: adminId,
      eventType: 'driver.location_history_viewed',
      entity: 'driver',
      entityId: driverId,
      data: { from: from.toISOString(), to: to.toISOString(), points: summary.count },
    });

    return {
      points: rows.map((p) => ({
        lat: p.lat,
        lon: p.lon,
        accuracyM: p.accuracyM,
        recordedAt: p.recordedAt.toISOString(),
        createdAt: p.createdAt.toISOString(),
        delaySeconds: p.delaySeconds,
      })),
      summary: {
        count: summary.count,
        firstAt: summary.firstAt ? summary.firstAt.toISOString() : null,
        lastAt: summary.lastAt ? summary.lastAt.toISOString() : null,
        maxDelaySeconds: summary.maxDelaySeconds,
      },
      truncated: rows.length < summary.count,
    };
  }

  /**
   * Resolves stored photo paths into signed URLs in a SINGLE round trip to the
   * bucket, same as the affiliates list. A path that cannot be signed becomes
   * null and the panel falls back to initials — one broken photo must never
   * fail the map.
   */
  private async signAvatars<T extends { photoUrl: string | null }>(items: T[]): Promise<T[]> {
    const storage = this.app.storage;
    const paths = items.map((i) => i.photoUrl).filter((p): p is string => Boolean(p));
    if (!storage || paths.length === 0) {
      return items.map((i) => ({ ...i, photoUrl: null }));
    }
    const signed = await storage
      .getSignedUrls(paths, AVATAR_TTL_SECONDS)
      .catch(() => new Map<string, string>());
    return items.map((i) => ({ ...i, photoUrl: (i.photoUrl && signed.get(i.photoUrl)) || null }));
  }
}
