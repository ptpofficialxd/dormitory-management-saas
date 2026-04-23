import {
  type Slip,
  type SlipUploadUrlInput,
  type SlipUploadUrlResponse,
  type SlipViewUrlResponse,
  type UploadSlipInput,
  slipUploadUrlInputSchema,
  uploadSlipInputSchema,
} from '@dorm/shared/zod';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Perm } from '../../common/decorators/perm.decorator.js';
import { ZodBody } from '../../common/decorators/zod-body.decorator.js';
import { SlipService } from './slip.service.js';

/**
 * Slip endpoints — split across two URL trees:
 *
 *   - `POST /c/:slug/payments/:paymentId/slip/upload-url` — mint presigned PUT
 *   - `POST /c/:slug/payments/:paymentId/slip`            — register after upload
 *   - `GET  /c/:slug/payments/:paymentId/slip`            — fetch slip metadata
 *   - `GET  /c/:slug/slips/:id/view-url`                  — mint presigned GET
 *   - `GET  /c/:slug/slips/:id`                           — slip detail (admin)
 *
 * RBAC:
 *   - upload-url + register : `tenant` for own LIFF flow + `staff` /
 *     `property_manager` / `company_owner` for admin-recorded payments.
 *     The Phase-2 LIFF tenant routes will live under `/me/payments/...`
 *     with a separate controller scoped by JWT subject — for MVP this
 *     controller carries the admin path AND tenants share it (tenant role
 *     listed in @Roles for forward-compat).
 *   - view-url + GET        : `company_owner`, `property_manager`, `staff`,
 *     `tenant` (a tenant viewing their own slip is fine — we'd add a
 *     "is owner of payment" guard in Phase-2 LIFF tenant flow).
 *
 * No PATCH / DELETE — slips are append-only by design (audit + fraud
 * trail). To "replace" a slip, the manager rejects the payment, the
 * tenant creates a new payment, and uploads a fresh slip against it.
 *
 * Idempotency: NOT applied here. Slip's `paymentId @unique` already
 * gives us the right shape — a re-played register hits 409 instead of
 * silently no-op'ing, which is the correct UX (the tenant should know
 * something raced them).
 */
@Controller('c/:companySlug')
export class SlipController {
  constructor(private readonly slipService: SlipService) {}

  /**
   * Step 1 of the upload flow. Returns `{ url, r2ObjectKey, expiresAt }`
   * — client PUTs raw bytes to `url`, then calls register with the
   * echoed `r2ObjectKey`.
   *
   * 201 because we're "creating" a signed URL grant + reserving a key,
   * even though no DB row is written yet.
   */
  @Post('payments/:paymentId/slip/upload-url')
  @HttpCode(201)
  @Perm('create', 'slip')
  createUploadUrl(
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @ZodBody(slipUploadUrlInputSchema) body: SlipUploadUrlInput,
  ): Promise<SlipUploadUrlResponse> {
    return this.slipService.createUploadUrl(paymentId, body);
  }

  /**
   * Step 3 of the upload flow. Persists the Slip row after the client
   * has PUT raw bytes to R2. Server HEADs R2 + validates prefix +
   * cross-checks size before insert.
   */
  @Post('payments/:paymentId/slip')
  @HttpCode(201)
  @Perm('create', 'slip')
  register(
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @ZodBody(uploadSlipInputSchema) body: UploadSlipInput,
  ): Promise<Slip> {
    return this.slipService.register(paymentId, body);
  }

  /** Fetch slip metadata for a payment (admin / tenant own-view). */
  @Get('payments/:paymentId/slip')
  @Perm('read', 'slip')
  getByPaymentId(@Param('paymentId', new ParseUUIDPipe()) paymentId: string): Promise<Slip> {
    return this.slipService.getByPaymentId(paymentId);
  }

  /**
   * Mint a short-lived signed GET URL for previewing the slip image
   * in the admin dashboard / LIFF tenant. TTL is bounded by
   * `R2_SIGNED_URL_TTL` (5 min default) per CLAUDE.md §3.9.
   */
  @Get('slips/:id/view-url')
  @Perm('read', 'slip')
  getViewUrl(@Param('id', new ParseUUIDPipe()) id: string): Promise<SlipViewUrlResponse> {
    return this.slipService.getViewUrl(id);
  }

  /** Slip detail by id — admin path. */
  @Get('slips/:id')
  @Perm('read', 'slip')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<Slip> {
    return this.slipService.getById(id);
  }
}
