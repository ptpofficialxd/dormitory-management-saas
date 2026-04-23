import {
  type CompanyLineChannelPublic,
  type UpsertCompanyLineChannelInput,
  upsertCompanyLineChannelInputSchema,
} from '@dorm/shared/zod';
import { Controller, Get, Put } from '@nestjs/common';
import { Perm } from '../../common/decorators/perm.decorator.js';
import { ZodBody } from '../../common/decorators/zod-body.decorator.js';
import { CompanyLineChannelService } from './company-line-channel.service.js';

/**
 * Admin endpoints for the per-company LINE channel configuration.
 * Path scoped under `/c/:companySlug/line-channel`.
 *
 * Both endpoints sit behind RBAC: only `company_owner` and
 * `property_manager` may view OR mutate. `staff` is intentionally
 * excluded — handing the channelSecret to day-to-day staff would
 * widen the blast radius if a staff account is phished. Staff don't
 * need it for the day job (sending replies goes through service-level
 * helpers, not raw access tokens).
 *
 * No DELETE — to "remove" a channel, the admin upserts an empty value
 * via a dedicated endpoint (Phase 1.5). For MVP we keep the surface
 * minimal: GET (status check) + PUT (configure / rotate).
 *
 * Note: there is NO endpoint here that returns the secret/access-token
 * plaintext to the browser. The webhook controller reads them
 * server-side via `findByChannelIdUnscoped()` only.
 */
@Controller('c/:companySlug/line-channel')
export class CompanyLineChannelController {
  constructor(private readonly service: CompanyLineChannelService) {}

  @Get()
  @Perm('read', 'company')
  get(): Promise<CompanyLineChannelPublic> {
    return this.service.getForCurrentCompany();
  }

  @Put()
  @Perm('update', 'company')
  upsert(
    @ZodBody(upsertCompanyLineChannelInputSchema) body: UpsertCompanyLineChannelInput,
  ): Promise<CompanyLineChannelPublic> {
    return this.service.upsert(body);
  }
}
