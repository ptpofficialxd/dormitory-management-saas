import {
  type Invoice,
  type ListInvoicesQuery,
  type TenantJwtClaims,
  listInvoicesQuerySchema,
} from '@dorm/shared/zod';
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator.js';
import { TenantAuth } from '../../common/decorators/tenant-auth.decorator.js';
import { ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { InvoiceService } from './invoice.service.js';

/**
 * `/me/invoices` — LIFF tenant-facing read surface.
 *
 * @TenantAuth() at the class level routes JwtGuard through
 * `verifyTenantToken()` (audience='dorm-liff', typ='liff'). The companyId
 * for RLS comes from the same JWT and is plumbed by TenantContextInterceptor.
 *
 * Tenant scoping — defence in depth:
 *   1. RLS at the DB layer enforces companyId via `app.company_id`.
 *   2. We OVERRIDE `query.tenantId` with the JWT's `sub` so a user
 *      passing `?tenantId=other-uuid` cannot peek at a same-company sibling.
 *   3. `getByIdForTenant` filters on (id, tenantId) — cross-tenant probes
 *      get a 404 (NEVER 403 — we do not leak existence).
 *   4. `listForTenant` / `getByIdForTenant` ALSO hide `draft` + `void`
 *      invoices — drafts are admin-only pre-commit work, voided invoices
 *      no longer obligate the tenant. Same 404 posture for guessed URLs.
 *
 * No write endpoints here — payment creation lives in MePaymentController
 * (Task #77) so the auth-domain split stays clean (one controller per
 * resource family).
 */
@Controller('me/invoices')
@TenantAuth()
export class MeInvoiceController {
  constructor(private readonly invoiceService: InvoiceService) {}

  @Get()
  list(
    @ZodQuery(listInvoicesQuerySchema) query: ListInvoicesQuery,
    @CurrentTenant() tenant: TenantJwtClaims,
  ): Promise<CursorPage<Invoice>> {
    // Use the tenant-scoped variant — pins tenantId to JWT.sub AND hides
    // `draft` / `void` statuses (which are admin-only). Caller-supplied
    // `tenantId` in the query is ignored by `listForTenant` for the same
    // defence-in-depth reason as `getByIdForTenant`.
    return this.invoiceService.listForTenant(query, tenant.sub);
  }

  @Get(':id')
  getById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentTenant() tenant: TenantJwtClaims,
  ): Promise<Invoice> {
    return this.invoiceService.getByIdForTenant(id, tenant.sub);
  }
}
