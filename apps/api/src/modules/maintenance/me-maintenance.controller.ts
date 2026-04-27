import {
  type CreateMaintenanceRequestInput,
  type ListMaintenanceRequestsInput,
  type MaintenancePhotoUploadUrlInput,
  type MaintenancePhotoUploadUrlResponse,
  type MaintenancePhotoViewUrlResponse,
  type MaintenanceRequest,
  type TenantJwtClaims,
  createMaintenanceRequestInputSchema,
  listMaintenanceRequestsInputSchema,
  maintenancePhotoUploadUrlInputSchema,
} from '@dorm/shared/zod';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator.js';
import { TenantAuth } from '../../common/decorators/tenant-auth.decorator.js';
import { ZodBody, ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { MaintenanceService } from './maintenance.service.js';

/**
 * `/me/maintenance` — LIFF tenant maintenance flow.
 *
 * Same defence-in-depth posture as MeInvoiceController / MePaymentController:
 *   1. RLS at DB layer (companyId via app.company_id)
 *   2. tenantId forced from JWT.sub on every list / get / create / upload
 *   3. Cross-tenant probes get 404 (NEVER 403)
 *
 * Photo upload flow (mirrors slip's 3-hop):
 *   1. POST /me/maintenance/photos/upload-url    → presigned PUT URL + key
 *      (one call per photo — call N times for N photos)
 *   2. PUT raw bytes to R2 directly (browser → R2, no API hop)
 *   3. POST /me/maintenance with `photoR2Keys: [keys...]`
 *      → server R2-HEADs each key + verifies prefix + creates ticket
 *
 * No Idempotency-Key on POST — the underlying create has no DB unique key
 * to dedupe on (tickets are not (tenant, period)-keyed like invoices).
 * Worst case: tenant double-taps + creates 2 identical tickets, admin
 * cancels the duplicate. Acceptable for MVP given the low blast radius.
 */
@Controller('me/maintenance')
@TenantAuth()
export class MeMaintenanceController {
  constructor(private readonly service: MaintenanceService) {}

  // ---------------------------------------------------------------------
  // Read paths
  // ---------------------------------------------------------------------

  @Get()
  list(
    @ZodQuery(listMaintenanceRequestsInputSchema) query: ListMaintenanceRequestsInput,
    @CurrentTenant() tenant: TenantJwtClaims,
  ): Promise<CursorPage<MaintenanceRequest>> {
    // Force tenantId from JWT — ignore caller-supplied ?tenantId=...
    return this.service.listForTenant(query, tenant.sub);
  }

  @Get(':id')
  getById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentTenant() tenant: TenantJwtClaims,
  ): Promise<MaintenanceRequest> {
    return this.service.getByIdForTenant(id, tenant.sub);
  }

  /**
   * View a photo from one of the caller's own tickets. Ownership pre-check
   * via `getByIdForTenant` ensures cross-tenant probes 404 before we mint
   * a signed URL — without this, tenant A could enumerate tenant B's photo
   * keys (if they could guess them, which they can't, but defense-in-depth).
   */
  @Get(':id/photos/:key/view-url')
  async getPhotoViewUrl(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('key') key: string,
    @CurrentTenant() tenant: TenantJwtClaims,
  ): Promise<MaintenancePhotoViewUrlResponse> {
    await this.service.getByIdForTenant(id, tenant.sub);
    return this.service.getPhotoViewUrl(id, key);
  }

  // ---------------------------------------------------------------------
  // Write paths
  // ---------------------------------------------------------------------

  /**
   * Step 1 of the create flow — mint a presigned PUT URL for a single
   * photo. Tenant calls this once per photo (typical: 1-3 times) before
   * submitting the ticket.
   *
   * Key is server-generated `companies/{companyId}/maintenance/{tenantId}/
   * {uuid}.{ext}` so a tampered echo from the client gets caught at create
   * time by the prefix check.
   */
  @Post('photos/upload-url')
  @HttpCode(201)
  createPhotoUploadUrl(
    @ZodBody(maintenancePhotoUploadUrlInputSchema) body: MaintenancePhotoUploadUrlInput,
    @CurrentTenant() tenant: TenantJwtClaims,
  ): Promise<MaintenancePhotoUploadUrlResponse> {
    return this.service.createPhotoUploadUrl(body, tenant.sub);
  }

  /**
   * Step 3 of the create flow — submit the ticket with the array of R2
   * keys collected from prior upload-url calls. Service:
   *   - Auto-derives unitId from the tenant's active contract
   *   - Validates each photoR2Key has the tenant's prefix
   *   - HEADs R2 to confirm each photo actually landed
   *   - Inserts the ticket in `open` state
   */
  @Post()
  @HttpCode(201)
  create(
    @ZodBody(createMaintenanceRequestInputSchema) body: CreateMaintenanceRequestInput,
    @CurrentTenant() tenant: TenantJwtClaims,
  ): Promise<MaintenanceRequest> {
    return this.service.createForTenant(body, tenant.sub);
  }
}
