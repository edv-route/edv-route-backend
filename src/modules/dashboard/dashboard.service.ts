import type { SettingsRepository } from '../settings/settings.repository.js';
import type {
  DashboardRepository,
  DashboardSummary,
  RevenueSeriesPoint,
} from './dashboard.repository.js';

/** Panel-side warning window for document expiry; UI concern, not a business setting. */
const DOCUMENT_WARNING_DAYS = 30;

/**
 * Read-only aggregation over existing domains. The activity feed is NOT
 * served here: the panel reuses GET /audit-logs for it (single source).
 */
export class DashboardService {
  constructor(
    private readonly dashboard: DashboardRepository,
    private readonly settings: SettingsRepository,
  ) {}

  async summary(): Promise<DashboardSummary> {
    const reminderDays = await this.settings.get('payment_reminder_days', 3);
    const timezone = await this.settings.get('business_timezone', 'America/Caracas');
    return this.dashboard.summary(Number(reminderDays), DOCUMENT_WARNING_DAYS, String(timezone));
  }

  /** Daily invoicing series for the revenue chart (business-timezone days). */
  async revenueSeries(days: number): Promise<RevenueSeriesPoint[]> {
    const timezone = await this.settings.get('business_timezone', 'America/Caracas');
    return this.dashboard.revenueSeries(days, String(timezone));
  }
}
