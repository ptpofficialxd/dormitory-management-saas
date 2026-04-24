import type { SlipViewUrlResponse, TenantJwtClaims } from '@dorm/shared/zod';
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator.js';
import { TenantAuth } from '../../common/decorators/tenant-auth.decorator.js';
import { SlipService } from './slip.service.js';

/**
 * `/me/slips/:id/view-url` — LIFF presigned-GET endpoint.
 *
 * Sits in its own controller (separate from `MePaymentController`) because
 * the URL is keyed by `slipId`, not `paymentId`. Same `@TenantAuth()`
 * posture; ownership enforced via `slip.payment.tenantId` in the service.
 *
 * URL TTL ~5 min per CLAUDE.md §3 #9. Mint fresh per view; never cache.
 */
@Controller('me/slips')
@TenantAuth()
export class MeSlipController {
  constructor(private readonly slipService: SlipService) {}

  @Get(':id/view-url')
  getViewUrl(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentTenant() tenant: TenantJwtClaims,
  ): Promise<SlipViewUrlResponse> {
    return this.slipService.getViewUrlForTenant(id, tenant.sub);
  }
}
