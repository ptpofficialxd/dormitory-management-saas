import {
  type AdminJwtClaims,
  type Company,
  type MeResponse,
  type UpdatePromptPaySettingsInput,
  updatePromptPaySettingsInputSchema,
} from '@dorm/shared/zod';
import { Controller, Get, HttpCode, Put } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Perm } from '../../common/decorators/perm.decorator.js';
import { ZodBody } from '../../common/decorators/zod-body.decorator.js';
import { CompanyService } from './company.service.js';

/**
 * Company-scoped endpoints. All routes live under `/c/:companySlug/…` so the
 * global `PathCompanyGuard` enforces slug-parity with the JWT's `companySlug`.
 *
 * Routes:
 *   GET /c/:companySlug/me           → current admin profile + company summary
 *   GET /c/:companySlug              → full company row (for Settings page)
 *   PUT /c/:companySlug/prompt-pay   → set PromptPay payee config (owner-only)
 *
 * Generic Company CRUD (rename / delete / status flip) stays out — it's
 * platform-level (super_admin only, post-MVP).
 */
@Controller('c/:companySlug')
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  @Get('me')
  me(@CurrentUser() user: AdminJwtClaims): Promise<MeResponse> {
    return this.companyService.getMe(user);
  }

  /**
   * `GET /c/:companySlug` — full company row, including PromptPay config.
   * Powers the Settings page. RBAC: read:company (owner + property_manager
   * per the matrix; staff doesn't see the Settings nav item).
   */
  @Get()
  @Perm('read', 'company')
  getCurrent(): Promise<Company> {
    return this.companyService.getCurrent();
  }

  /**
   * `PUT /c/:companySlug/prompt-pay` — set the company's PromptPay payee
   * config. Owner-only per the shared RBAC matrix (`company:update` is
   * NOT in property_manager's permission set).
   *
   * Idempotent — re-PUT with the same payload is a no-op at the DB level
   * (Prisma update returns the row, RLS still scopes by companyId).
   */
  @Put('prompt-pay')
  @HttpCode(200)
  @Perm('update', 'company')
  setPromptPay(
    @ZodBody(updatePromptPaySettingsInputSchema) body: UpdatePromptPaySettingsInput,
  ): Promise<Company> {
    return this.companyService.setPromptPay(body);
  }
}
