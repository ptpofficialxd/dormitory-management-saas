import { prisma } from '@dorm/db';
import type { AdminJwtClaims } from '@dorm/shared/zod';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type Observable, tap } from 'rxjs';

/**
 * Writes an `audit_log` row for every mutating request (POST/PUT/PATCH/DELETE)
 * that completed successfully. Required by CLAUDE.md §3.7 for any mutation
 * touching PII or money. Applied globally, but skipped on non-mutating verbs
 * so GET/HEAD don't spam the log.
 *
 * `audit_log` is RLS-scoped + append-only (DB triggers deny UPDATE/DELETE),
 * so this interceptor relies on `TenantContextInterceptor` running FIRST to
 * set `app.company_id` on the active tx — otherwise the INSERT would hit
 * default-deny and fail.
 *
 * On write failure (e.g. DB down) we log-and-swallow — we'd rather ship the
 * response than fail the user's action because the audit log is unreachable.
 * Observability + alerting will catch persistent failures.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AdminJwtClaims; id?: string }>();
    if (!MUTATING_METHODS.has(req.method)) return next.handle();

    const user = req.user;
    // Only log within a tenant context — anonymous mutations are impossible
    // because JwtGuard would have rejected them (public routes are read-only
    // by convention: health, login, refresh).
    if (!user) return next.handle();

    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip ??
      null;
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;

    return next.handle().pipe(
      tap({
        next: async () => {
          try {
            await prisma.auditLog.create({
              data: {
                companyId: user.companyId,
                actorUserId: user.sub,
                action: `${req.method} ${req.routeOptions?.url ?? req.url}`,
                resource: deriveResource(req.url),
                resourceId: null,
                metadata: {},
                ipAddress: ip,
                userAgent,
              },
            });
          } catch (err) {
            this.logger.error(
              `Failed to write audit_log for ${req.method} ${req.url}: ${(err as Error).message}`,
            );
          }
        },
      }),
    );
  }
}

/**
 * Resource label = the first meaningful segment of the path. `/c/:slug/units/:id`
 * → `unit`. Good enough for MVP; can be replaced with per-handler metadata later.
 */
function deriveResource(url: string): string {
  const path = url.split('?')[0] ?? url;
  const parts = path.split('/').filter(Boolean);
  // Skip `c/:slug` prefix if present.
  const start = parts[0] === 'c' ? 2 : 0;
  const resource = parts[start] ?? 'unknown';
  return resource.endsWith('s') ? resource.slice(0, -1) : resource;
}
