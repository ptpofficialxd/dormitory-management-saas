import type { AdminJwtClaims } from '@dorm/shared/zod';
import { type ExecutionContext, createParamDecorator } from '@nestjs/common';

/**
 * Extracts the verified JWT claims off the request. Populated by `JwtGuard`
 * as `request.user` — type matches `adminJwtClaimsSchema`.
 *
 * Example: `handler(@CurrentUser() user: AdminJwtClaims) { ... }`
 */
export const CurrentUser = createParamDecorator<keyof AdminJwtClaims | undefined>(
  (data, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: AdminJwtClaims }>();
    const user = req.user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);
