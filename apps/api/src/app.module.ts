import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter.js';
import { JwtGuard } from './common/guards/jwt.guard.js';
import { PathCompanyGuard } from './common/guards/path-company.guard.js';
import { RbacGuard } from './common/guards/rbac.guard.js';
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor.js';
import { TenantContextInterceptor } from './common/middleware/tenant-context.interceptor.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { CompanyModule } from './modules/company/company.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { StorageModule } from './modules/storage/storage.module.js';

/**
 * Root module — wires global cross-cutting concerns once.
 *
 * Order matters because Nest applies them in registration order:
 *
 *   GUARDS:        JwtGuard → RbacGuard → PathCompanyGuard
 *     1. JwtGuard verifies the bearer token, attaches `req.user`. Public
 *        routes short-circuit here.
 *     2. RbacGuard reads `@Roles(…)` metadata; allows if no roles required.
 *     3. PathCompanyGuard ensures URL `:companySlug` ≡ `req.user.companySlug`
 *        on `/c/:companySlug/…` routes.
 *
 *   INTERCEPTORS:  TenantContext → AuditLog
 *     1. TenantContext wraps the handler in `withTenant({companyId}, fn)` so
 *        every Prisma query inside runs with `SET LOCAL app.company_id = …`.
 *     2. AuditLog runs AFTER the handler returns, inside the same tx — so the
 *        `audit_log` insert respects RLS.
 *
 *   FILTER: GlobalExceptionFilter normalises every error into one envelope.
 *
 * To skip the global JwtGuard on a route: decorate with `@Public()`.
 * To require roles: decorate with `@Roles('company_owner', 'property_manager')`.
 */
@Module({
  imports: [StorageModule, HealthModule, AuthModule, CompanyModule, BillingModule],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: JwtGuard },
    { provide: APP_GUARD, useClass: RbacGuard },
    { provide: APP_GUARD, useClass: PathCompanyGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
  ],
})
export class AppModule {}
