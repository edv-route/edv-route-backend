import type { SettingsRepository } from '../settings/settings.repository.js';
import type { DashboardRepository, DashboardSummary } from './dashboard.repository.js';

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
    return this.dashboard.summary(Number(reminderDays));
  }
}
