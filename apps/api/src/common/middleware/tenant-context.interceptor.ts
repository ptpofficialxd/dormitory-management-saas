import { withTenant } from '@dorm/db';
import type { AdminJwtClaims } from '@dorm/shared/zod';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { defer, from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';

/**
 * Wraps the handler pipeline in `withTenant(ctx, fn)` so every Prisma query
 * made during the request runs inside a RLS-scoped transaction with
 * `SET LOCAL app.company_id = <user.companyId>` applied (ADR-0002).
 *
 * Implementation note — why an Interceptor, not Nest `Middleware`:
 *   Nest middleware fires BEFORE guards. We need the guard's `request.user`
 *   to be populated first (JwtGuard decodes it there), so we hook at the
 *   interceptor stage, which runs after guards but before the handler.
 *
 * If `request.user` is absent (public endpoint) we skip the wrap — no tenant
 * context means any Prisma call will hit the default-deny branch and fail
 * loudly, which is the correct behaviour (never silently cross tenants).
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AdminJwtClaims }>();
    const user = req.user;
    if (!user) {
      return next.handle();
    }

    // `defer` + `from(Promise)` keeps the result observable-compatible so
    // Nest's response pipeline (filters, interceptors downstream) still runs.
    return defer(() =>
      from(withTenant({ companyId: user.companyId }, () => firstValueFromHandler(next))),
    ).pipe(mergeMap((v) => Promise.resolve(v)));
  }
}

/**
 * Pulls the first emission out of `next.handle()` as a Promise. Nest's
 * `CallHandler` returns an Observable; for REST endpoints there's always
 * exactly one emission (the response body).
 */
function firstValueFromHandler(next: CallHandler): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sub = next.handle().subscribe({
      next: (v) => {
        resolve(v);
        sub.unsubscribe();
      },
      error: reject,
    });
  });
}
