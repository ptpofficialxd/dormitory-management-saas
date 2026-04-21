import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key checked by `JwtGuard` — if present, the guard skips JWT
 * verification. Apply to endpoints that MUST be reachable without auth
 * (health check, login, refresh).
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
