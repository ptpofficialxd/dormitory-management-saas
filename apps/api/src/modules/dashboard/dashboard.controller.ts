import type { DashboardSummary } from '@dorm/shared/zod';
import { Controller, Get } from '@nestjs/common';
import { Perm } from '../../common/decorators/perm.decorator.js';
import { DashboardService } from './dashboard.service.js';

/**
 * Dashboard endpoints — `/c/:companySlug/dashboard`.
 *
 * RBAC:
 *   - `GET /summary` : `dashboard:read` — owner / manager / staff. Tenants
 *     and guardians never see admin KPIs (their LIFF surfaces show their
 *     own bills/maintenance, not company-wide aggregates).
 *
 * Audit log:
 *   - Read-only endpoint; AuditLogInterceptor intentionally skips GETs
 *     (CLAUDE.md §3.7 — audit covers mutations on PII/money). No extra
 *     wiring here.
 *
 * Future shape (Phase 1+):
 *   - GET /summary  — current snapshot (this file)
 *   - GET /aging    — invoice-level drill-down for the arrears card
 *   - GET /cashflow — month-over-month chart series
 *   The `/summary` path is reserved now so adding sub-resources later
 *   doesn't break the base URL.
 */
@Controller('c/:companySlug/dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  @Perm('read', 'dashboard')
  getSummary(): Promise<DashboardSummary> {
    return this.dashboardService.getSummary();
  }
}
