import type { Role } from '@dorm/shared';
import type { AdminJwtClaims } from '@dorm/shared/zod';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ROLES_KEY } from '../decorators/roles.decorator.js';

/**
 * Reads `@Roles(...)` metadata and asserts the current user holds ≥1 of the
 * listed roles. Runs AFTER `JwtGuard` (guard order is registration order).
 *
 * Missing `@Roles()` metadata = allow any authenticated user (don't assume
 * "restrict by default" — that would force every endpoint to tag roles even
 * when all authenticated users should pass).
 */
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const allowedRoles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!allowedRoles || allowedRoles.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AdminJwtClaims }>();
    const user = req.user;
    if (!user) throw new ForbiddenException('Authenticated user required');

    const hasRole = user.roles.some((r) => allowedRoles.includes(r));
    if (!hasRole) {
      throw new ForbiddenException(`Insufficient role. Required: ${allowedRoles.join(' | ')}`);
    }
    return true;
  }
}
