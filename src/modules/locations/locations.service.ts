import type { FastifyInstance } from 'fastify';
import { SettingsRepository } from '../settings/settings.repository.js';
import { CAN_OPERATE_STATUSES } from '../driver-auth/driver-auth.service.js';
import { readIntervalSeconds, readRetentionDays } from './locations.settings.js';
import type { LocationPoint, LocationsRepository } from './locations.repository.js';

/**
 * How far back a point may claim to have been taken. The local queue is the
 * whole reason to accept past points at all, but without a ceiling anyone
 * holding a driver token could post a fabricated trail for last week.
 */
const MAX_BACKDATE_MS = 24 * 60 * 60 * 1000;

/**
 * Clock skew allowance. Phone clocks drift, and a point stamped 40 seconds in
 * the future is a wrong clock, not a forgery — rejecting it would silently
 * discard every point from a handful of phones.
 */
const MAX_FUTURE_MS = 5 * 60 * 1000;

export interface ReportResult {
  /** How many points were actually stored. */
  accepted: number;
  /** Points dropped for being unusable (bad coordinates, too old, too far ahead). */
  rejected: number;
  /** What the app should use from now on, so a change reaches it without a new APK. */
  intervalSeconds: number;
}

export class LocationsService {
  private readonly settings: SettingsRepository;

  constructor(
    private readonly app: FastifyInstance,
    private readonly repo: LocationsRepository,
  ) {
    this.settings = new SettingsRepository(app.db);
  }

  /** Seconds between reports while idle. Read from settings on every call. */
  async intervalSeconds(): Promise<number> {
    return readIntervalSeconds(this.settings);
  }

  /** Days of history kept. Read by the purge job on every pass. */
  async retentionDays(): Promise<number> {
    return readRetentionDays(this.settings);
  }

  /**
   * Takes a batch from the app.
   *
   * A driver who may not report gets a **403 with the reason**, which the app
   * uses to stop the foreground service. That is the difference between a phone
   * that goes quiet when its owner is suspended and one that keeps waking the
   * GPS every ten minutes for a request that will never be accepted.
   */
  async report(driverId: string, points: LocationPoint[]): Promise<ReportResult> {
    const { httpErrors } = this.app;

    const eligibility = await this.repo.checkEligibility(driverId, CAN_OPERATE_STATUSES);
    if (!eligibility.allowed) {
      throw httpErrors.forbidden(eligibility.reason ?? 'No puedes reportar tu ubicación');
    }

    const now = Date.now();
    // Bad points are DROPPED, not fatal: one corrupt reading must not throw away
    // the nineteen good ones queued behind it.
    const usable = points.filter((p) => this.isUsable(p, now));

    const accepted = await this.repo.insertBatch(driverId, usable);
    const rejected = points.length - usable.length;

    if (rejected > 0) {
      this.app.log.warn({ driverId, rejected, total: points.length }, 'locations: puntos descartados');
    }

    return { accepted, rejected, intervalSeconds: await this.intervalSeconds() };
  }

  private isUsable(point: LocationPoint, now: number): boolean {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return false;
    if (point.lat < -90 || point.lat > 90) return false;
    if (point.lon < -180 || point.lon > 180) return false;

    // (0, 0) is in the Atlantic off Africa. It is what a phone reports when it
    // has no fix at all, never a real position for this fleet.
    if (point.lat === 0 && point.lon === 0) return false;

    const at = point.recordedAt.getTime();
    if (!Number.isFinite(at)) return false;
    if (at > now + MAX_FUTURE_MS) return false;
    if (at < now - MAX_BACKDATE_MS) return false;

    return true;
  }
}
