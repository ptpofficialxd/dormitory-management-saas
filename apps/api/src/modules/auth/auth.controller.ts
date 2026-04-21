import {
  type AdminJwtClaims,
  type AuthTokens,
  type LoginAdminInput,
  type RefreshTokenInput,
  loginAdminInputSchema,
  refreshTokenInputSchema,
} from '@dorm/shared/zod';
import { Controller, HttpCode, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { ZodBody } from '../../common/decorators/zod-body.decorator.js';
import { AuthService } from './auth.service.js';

/**
 * Admin auth endpoints. LIFF (tenant-facing) auth lives in a separate module
 * added in Phase 2 — keeping them apart avoids mixing JWT audiences.
 *
 * Routes:
 *   POST /auth/login    — public, rate-limit in front of it in prod
 *   POST /auth/refresh  — public (refresh token IS the credential)
 *   POST /auth/logout   — authenticated; logs intent, no-op in MVP
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @Public()
  login(@ZodBody(loginAdminInputSchema) body: LoginAdminInput): Promise<AuthTokens> {
    return this.authService.loginAdmin(body);
  }

  @Post('refresh')
  @HttpCode(200)
  @Public()
  refresh(@ZodBody(refreshTokenInputSchema) body: RefreshTokenInput): Promise<AuthTokens> {
    return this.authService.refresh(body);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AdminJwtClaims): Promise<void> {
    await this.authService.logout(user);
  }
}
