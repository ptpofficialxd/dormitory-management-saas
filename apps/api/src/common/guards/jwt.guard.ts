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

/**
 * Verifies the `Authorization: Bearer <token>` header against our JWT service
 * and attaches the decoded claims as `request.user`. Public endpoints
 * (marked with `@Public()`) bypass the check entirely.
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

    try {
      const claims = await this.jwtService.verifyAccessToken(token);
      req.user = claims;
      return true;
    } catch {
      // Never leak token-failure reason (expired vs. bad sig vs. wrong typ).
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
