import { Module } from '@nestjs/common';
import { AuditLogController } from './audit-log.controller.js';
import { AuditLogReadService } from './audit-log.service.js';

/**
 * Audit log read endpoints (Task #119 / SAAS-003).
 *
 * Write-side already lives in `common/interceptors/audit-log.interceptor.ts`
 * (auto-emit on every authenticated mutation) + service-level emits (signup,
 * trial.warning, etc.). This module owns the READ surface only.
 *
 * Naming note: the service is `AuditLogReadService` (not `AuditLogService`)
 * to make it visually obvious at the import site that this is a query
 * service, not a write service. If we add a write service later, it gets
 * its own clear name (`AuditLogWriteService`).
 */
@Module({
  controllers: [AuditLogController],
  providers: [AuditLogReadService],
  exports: [AuditLogReadService],
})
export class AuditLogModule {}
