import { type AuditLog, type ListAuditLogsInput, listAuditLogsInputSchema } from '@dorm/shared/zod';
import { Controller, Get } from '@nestjs/common';
import { Perm } from '../../common/decorators/perm.decorator.js';
import { ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { AuditLogReadService } from './audit-log.service.js';

/**
 * Audit log read endpoint — `/c/:companySlug/audit-logs` (Task #119).
 *
 * RBAC: `audit_log:read` — owner + property_manager per the matrix.
 * Staff / tenants / guardians never see audit rows.
 *
 * Audit log on the audit-log endpoint:
 *   - GET requests are skipped by AuditLogInterceptor (read-only by policy),
 *     so listing audit logs does NOT itself create an audit row. This is
 *     intentional: a noisy "owner viewed audit log" entry every few seconds
 *     during admin browsing would drown out real signal. If we later need
 *     "who viewed the audit log when", a dedicated `audit.view` event +
 *     dedup window (like trial.warning) is the right move.
 *
 * Why `/audit-logs` (plural) not `/audit-log`:
 *   - REST convention: collection endpoints are plural.
 *   - Web-admin nav uses `/audit-log` (singular) as the page route — feel
 *     free to harmonise later, but the API path stays plural.
 */
@Controller('c/:companySlug/audit-logs')
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogReadService) {}

  @Get()
  @Perm('read', 'audit_log')
  list(
    @ZodQuery(listAuditLogsInputSchema) query: ListAuditLogsInput,
  ): Promise<CursorPage<AuditLog>> {
    return this.auditLogService.list(query);
  }
}
