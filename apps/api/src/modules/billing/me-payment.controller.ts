import {
  type CreatePaymentInput,
  type ListPaymentsQuery,
  type Payment,
  type Slip,
  type SlipUploadUrlInput,
  type SlipUploadUrlResponse,
  type TenantJwtClaims,
  type UploadSlipInput,
  createPaymentInputSchema,
  listPaymentsQuerySchema,
  slipUploadUrlInputSchema,
  uploadSlipInputSchema,
} from '@dorm/shared/zod';
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator.js';
import { TenantAuth } from '../../common/decorators/tenant-auth.decorator.js';
import { ZodBody, ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { PaymentService } from './payment.service.js';
import { SlipService } from './slip.service.js';

/**
 * `/me/payments` — LIFF tenant payment + slip flow.
 *
 * Same defence-in-depth posture as `MeInvoiceController`:
 *   1. RLS at DB layer (companyId via app.company_id)
 *   2. tenantId forced from JWT.sub on list + create paths
 *   3. Cross-tenant probes get 404 (NEVER 403)
 *
 * Slip endpoints are nested here (not in a separate `/me/slips/*` family)
 * because every slip op is gated by `paymentId` — the same one-line
 * ownership guard `paymentService.getByIdForTenant(paymentId, tenant.sub)`
 * fronts every mutation/read. The `/me/slips/:id/view-url` route lives in
 * `MeSlipController` because it's keyed by slipId (no paymentId in URL).
 *
 * Slip upload flow (matches admin path):
 *   1. POST /me/payments/:id/slip/upload-url  → presigned PUT URL (5-min TTL)
 *   2. PUT to R2 directly (browser → R2, no API hop)
 *   3. POST /me/payments/:id/slip             → register Slip row + verify R2 HEAD
 *
 * Idempotency-Key REQUIRED on POST /me/payments (mirrors admin path) —
 * a tenant double-tapping the upload button shouldn't create two Payment rows.
 */
@Controller('me/payments')
@TenantAuth()
export class MePaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly slipService: SlipService,
  ) {}

  // ---------------------------------------------------------------------
  // Read paths
  // ---------------------------------------------------------------------

  @Get()
  list(
    @ZodQuery(listPaymentsQuerySchema) query: ListPaymentsQuery,
    @CurrentTenant() tenant: TenantJwtClaims,
  ): Promise<CursorPage<Payment>> {
    // Force tenantId from JWT — ignore caller-supplied ?tenantId=...
    return this.paymentService.list({ ...query, tenantId: tenant.sub });
  }

  @Get(':id')
  getById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentTenant() tenant: TenantJwtClaims,
  ): Promise<Payment> {
    return this.paymentService.getByIdForTenant(id, tenant.sub);
  }

  // ---------------------------------------------------------------------
  // Write paths — payment create
  // ---------------------------------------------------------------------

  @Post()
  @HttpCode(201)
  create(
    @ZodBody(createPaymentInputSchema) body: CreatePaymentInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentTenant() tenant: TenantJwtClaims,
  ): Promise<Payment> {
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new BadRequestException({
        error: 'IdempotencyKeyRequired',
        message: 'Idempotency-Key header is required (8–128 chars) for POST /me/payments',
      });
    }
    // createForTenant pre-checks invoice ownership before the underlying
    // create() runs — without this, a tenant could pay against a sibling's
    // invoice (the row would be mis-attributed because create() derives
    // tenantId from the invoice).
    return this.paymentService.createForTenant(body, idempotencyKey, tenant.sub);
  }

  // ---------------------------------------------------------------------
  // Slip endpoints — gated by payment ownership
  // ---------------------------------------------------------------------

  @Post(':paymentId/slip/upload-url')
  @HttpCode(201)
  async createSlipUploadUrl(
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @ZodBody(slipUploadUrlInputSchema) body: SlipUploadUrlInput,
    @CurrentTenant() tenant: TenantJwtClaims,
  ): Promise<SlipUploadUrlResponse> {
    // Ownership guard — 404 if payment isn't the caller's. Drops cleanly into
    // the slip service which derives the R2 key from companyId (RLS-scoped) +
    // paymentId, so we can't accidentally write to the wrong tenant's prefix.
    await this.paymentService.getByIdForTenant(paymentId, tenant.sub);
    return this.slipService.createUploadUrl(paymentId, body);
  }

  @Post(':paymentId/slip')
  @HttpCode(201)
  async registerSlip(
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @ZodBody(uploadSlipInputSchema) body: UploadSlipInput,
    @CurrentTenant() tenant: TenantJwtClaims,
  ): Promise<Slip> {
    await this.paymentService.getByIdForTenant(paymentId, tenant.sub);
    return this.slipService.register(paymentId, body);
  }

  @Get(':paymentId/slip')
  async getSlipByPayment(
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @CurrentTenant() tenant: TenantJwtClaims,
  ): Promise<Slip> {
    await this.paymentService.getByIdForTenant(paymentId, tenant.sub);
    return this.slipService.getByPaymentId(paymentId);
  }
}
