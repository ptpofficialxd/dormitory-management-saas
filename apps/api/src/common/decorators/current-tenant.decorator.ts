import type { TenantJwtClaims } from '@dorm/shared/zod';
import {
  type ExecutionContext,
  InternalServerErrorException,
  createParamDecorator,
} from '@nestjs/common';

/**
 * Extracts the verified tenant JWT claims off the request. Populated by
 * `JwtGuard` (in tenant-auth mode) as `request.user` — type matches
 * `tenantJwtClaimsSchema`.
 *
 * Defensive runtime check: rejects with 500 if the attached claims aren't a
 * tenant token. This catches the "forgot @TenantAuth() on the controller"
 * footgun — without the decorator the global guard attaches admin claims
 * (or none), and reading them as TenantJwtClaims would silently typo-cast
 * `sub` from user.id to tenant.id at runtime.
 *
 * Example:
 *   @TenantAuth()
 *   @Controller('/me/invoices')
 *   export class TenantInvoiceController {
 *     @Get()
 *     list(@CurrentTenant() tenant: TenantJwtClaims) {
 *       return this.svc.listForTenant(tenant.sub);
 *     }
 *   }
 */
export const CurrentTenant = createParamDecorator<keyof TenantJwtClaims | undefined>(
  (data, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: { typ?: string } }>();
    const user = req.user;
    if (!user || user.typ !== 'liff') {
      // Hard fail — this means the route is misconfigured (no @TenantAuth())
      // or the guard attached the wrong claim shape. NEVER fall through to
      // a 404 / silent miss — the controller would query with garbage IDs.
      throw new InternalServerErrorException(
        'CurrentTenant invoked on a route that did not run @TenantAuth() guard',
      );
    }
    const claims = user as TenantJwtClaims;
    return data ? claims[data] : claims;
  },
);
