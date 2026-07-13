import type { SettingsRepository } from '../settings/settings.repository.js';
import type {
  AuditLogsRepository,
  AuditLogFacets,
  AuditLogListFilters,
  AuditLogListResult,
} from './audit-logs.repository.js';

/**
 * Read-only module: audit entries are written by the acting services
 * (drivers, scheduler) and are never created or mutated through this API.
 */
export class AuditLogsService {
  constructor(
    private readonly auditLogs: AuditLogsRepository,
    private readonly settings: SettingsRepository,
  ) {}

  async list(filters: Omit<AuditLogListFilters, 'timezone'>): Promise<AuditLogListResult> {
    // Date filters mean calendar days for the business, not UTC days.
    const timezone = await this.settings.get('business_timezone', 'America/Caracas');
    return this.auditLogs.list({ ...filters, timezone: String(timezone) });
  }

  async facets(): Promise<AuditLogFacets> {
    return this.auditLogs.facets();
  }
}
