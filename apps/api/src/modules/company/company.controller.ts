import type { AdminJwtClaims } from '@dorm/shared/zod';
import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { CompanyService } from './company.service.js';

/**
 * Company-scoped endpoints. All routes live under `/c/:companySlug/…` so the
 * global `PathCompanyGuard` enforces slug-parity with the JWT's `companySlug`.
 *
 * Route plan for MVP:
 *   GET /c/:companySlug/me → { company, user, roles }
 *
 * Adding routes: keep them READ-ONLY here (profile, listing). Mutation-heavy
 * features live in their own modules (properties, units, contracts, …).
 */
@Controller('c/:companySlug')
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  @Get('me')
  me(@CurrentUser() user: AdminJwtClaims) {
    return this.companyService.getMe(user);
  }
}
