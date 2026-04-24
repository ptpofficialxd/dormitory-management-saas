import {
  type LoginLiffInput,
  type LoginLiffResponse,
  loginLiffInputSchema,
} from '@dorm/shared/zod';
import { Controller, HttpCode, Post } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { ZodBody } from '../../common/decorators/zod-body.decorator.js';
import { AuthService } from './auth.service.js';

/**
 * LIFF tenant auth — POST /me/auth/exchange.
 *
 * Why a separate controller from `AuthController`? The admin path lives
 * at `/auth/*` (non-tenanted, single audience). LIFF tenant routes live
 * under `/me/*` so the route prefix matches the rest of the tenant API
 * surface (`/me/invoices`, `/me/payments`, ...). Splitting controllers
 * keeps each route prefix in one file and prevents the admin Controller
 * from accumulating two audiences.
 *
 * The endpoint is `@Public()` because the LINE idToken IS the credential —
 * there's no pre-existing JWT to verify. After exchange, the LIFF client
 * uses the returned `token.accessToken` as `Bearer …` on subsequent
 * `/me/*` requests, which run through `JwtGuard` in tenant-auth mode
 * (`@TenantAuth()`).
 *
 * Errors: any failure (bad idToken, no bound tenant, suspended company)
 * surfaces as a uniform 401 — leaking which step failed would expose
 * tenant-binding state to the LINE login channel.
 */
@Controller('me/auth')
export class MeAuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('exchange')
  @HttpCode(200)
  @Public()
  exchange(@ZodBody(loginLiffInputSchema) body: LoginLiffInput): Promise<LoginLiffResponse> {
    return this.authService.exchangeLiffIdToken(body);
  }
}
