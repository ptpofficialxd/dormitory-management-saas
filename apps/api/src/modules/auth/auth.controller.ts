import {
  type AdminJwtClaims,
  type AuthTokens,
  type CheckSlugInput,
  type CheckSlugResponse,
  type LoginAdminInput,
  type RefreshTokenInput,
  type SignupInput,
  type SignupResponse,
  checkSlugInputSchema,
  loginAdminInputSchema,
  refreshTokenInputSchema,
  signupInputSchema,
} from '@dorm/shared/zod';
import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { ZodBody, ZodQuery } from '../../common/decorators/zod-body.decorator.js';
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

  // -----------------------------------------------------------------------
  // AUTH-004 self-signup (Tasks #113, #115)
  // -----------------------------------------------------------------------

  /**
   * Create a fresh company + owner account in one call. Returns the standard
   * AuthTokens envelope plus the new companyId/slug so the client can redirect
   * to `/c/:slug/welcome` without decoding the JWT.
   *
   * Public + rate-limited (Task #115). Errors:
   *   400 InvalidSlug    — shape or reserved-word violation
   *   409 SlugTaken      — race-safe duplicate-slug detection
   *   503                — JWT signing failure (misconfiguration)
   */
  @Post('signup')
  @HttpCode(200)
  @Public()
  signup(@ZodBody(signupInputSchema) body: SignupInput): Promise<SignupResponse> {
    return this.authService.signup(body);
  }

  /**
   * Slug availability probe used by the signup form for instant feedback as
   * the admin types. PUBLIC + rate-limited (Task #115).
   *
   * Returns 200 with a discriminated union — never 4xx for "unavailable".
   * The empty/long-string Zod failures (400) are the only client-input
   * mistakes the endpoint will reject outright; everything else (uppercase,
   * reserved word, taken) comes back as `{ available: false, reason }`.
   */
  @Get('check-slug')
  @HttpCode(200)
  @Public()
  checkSlug(@ZodQuery(checkSlugInputSchema) query: CheckSlugInput): Promise<CheckSlugResponse> {
    return this.authService.checkSlugAvailability(query.slug);
  }
}
