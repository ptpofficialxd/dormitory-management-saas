import type { AdminJwtClaims } from '@dorm/shared/zod';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Enforces that URL param `:companySlug` (or `:slug`) matches the JWT's
 * `companySlug` claim. Prevents a user with a valid token for `dorm-a` from
 * using the URL `/c/dorm-b/…` to address another tenant's namespace (defence-
 * in-depth on top of RLS — RLS would still refuse, but returning 403 early
 * gives a clean error and avoids wasting a DB round-trip).
 *
 * Attach globally via `APP_GUARD`; skipped automatically for routes that
 * don't include a slug param in their path (non-/c/:slug routes).
 */
@Injectable()
export class PathCompanyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AdminJwtClaims; params?: Record<string, string> }>();

    const paramSlug = req.params?.companySlug ?? req.params?.slug;
    if (!paramSlug) return true; // not a /c/:slug route — nothing to enforce

    const user = req.user;
    if (!user) {
      // Public route under /c/:slug? Odd but possible (e.g. public announcement
      // page). Without a user we can't enforce slug parity — let it through;
      // downstream code must validate slug→companyId on its own.
      return true;
    }

    if (paramSlug !== user.companySlug) {
      throw new ForbiddenException(
        `URL company '${paramSlug}' does not match authenticated tenancy '${user.companySlug}'`,
      );
    }
    return true;
  }
}
