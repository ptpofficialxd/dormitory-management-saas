import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { JwtService } from '../../modules/auth/jwt.service.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { IS_TENANT_AUTH_KEY } from '../decorators/tenant-auth.decorator.js';

/**
 * Verifies the `Authorization: Bearer <token>` header and attaches the
 * decoded claims as `request.user`. Public endpoints (marked with `@Public()`)
 * bypass the check entirely.
 *
 * Two verification modes — selected by route metadata:
 *
 *   default                        → admin token (verifyAccessToken)
 *                                    used by /c/:slug/* (admin web)
 *
 *   `@TenantAuth()` on handler     → tenant token (verifyTenantToken)
 *     or controller class            used by /me/* (LIFF tenant)
 *
 * Both modes share the same guard so the pipeline stays single-pass and
 * `@Public()` short-circuits both. The @CurrentUser / @CurrentTenant
 * decorators each runtime-assert the claim kind they extract — so a
 * mis-configured route (e.g. `@CurrentTenant` on a non-`@TenantAuth` route)
 * fails loudly instead of silently casting the wrong shape.
 *
 * Does NOT check roles — that's `RbacGuard`'s job so the two concerns stay
 * separable (a route may be "authenticated but any role" vs. "admin only").
 */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: unknown }>();
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();

    const isTenantAuth = this.reflector.getAllAndOverride<boolean>(IS_TENANT_AUTH_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    try {
      const claims = isTenantAuth
        ? await this.jwtService.verifyTenantToken(token)
        : await this.jwtService.verifyAccessToken(token);
      req.user = claims;
      return true;
    } catch {
      // Never leak token-failure reason (expired vs. bad sig vs. wrong typ).
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
