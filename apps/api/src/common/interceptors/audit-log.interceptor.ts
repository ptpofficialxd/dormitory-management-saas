import { Prisma, prisma } from '@dorm/db';
import type { AdminJwtClaims, TenantJwtClaims } from '@dorm/shared/zod';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type Observable, mergeMap } from 'rxjs';

/**
 * `req.user` is set by either JwtGuard (admin) or TenantJwtGuard (LIFF
 * tenant) — they share the same property name but the claim shapes diverge:
 *   - admin:  `{ sub: user.id, companyId, roles, typ: 'access', ... }`
 *   - tenant: `{ sub: tenant.id, companyId, lineUserId, typ: 'liff', ... }`
 * Use the `typ` discriminator to fan out — DON'T blindly write
 * `actorUserId: req.user.sub` for tenant requests, the FK to `user.id`
 * will explode and (because of ALS+Proxy tx, ADR-0001) take the whole
 * request tx down with it.
 */
type AnyClaims = AdminJwtClaims | TenantJwtClaims;

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
 * Why `mergeMap(async)` instead of `tap({ next: async })`?
 *   `tap` fires async callbacks fire-and-forget — the observable emits its
 *   value BEFORE the await resolves. That lets `TenantContextInterceptor`'s
 *   `firstValueFromHandler` resolve, `withTenant` returns, the request tx
 *   commits — and only THEN does our audit `INSERT` finally execute against
 *   a now-closed tx ("Transaction already closed"). `mergeMap` awaits the
 *   inner promise before emitting, so the audit insert happens INSIDE the
 *   same active tx as the request handler — RLS sees `app.company_id` and
 *   both writes commit atomically.
 *
 * On write failure (e.g. DB down) we log-and-swallow — we'd rather ship the
 * response than fail the user's action because the audit log is unreachable.
 * Note: a Postgres-level error inside the tx will still abort it on COMMIT,
 * which is actually the correct behaviour for transactional auditability.
 * Observability + alerting will catch persistent failures.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AnyClaims; id?: string }>();
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

    // Discriminate admin vs tenant claim. Admin's `sub` IS a `user.id`
    // (FK target). Tenant's `sub` is a `tenant.id` — passing it as
    // `actorUserId` would violate `audit_log_actor_user_id_fkey` and,
    // crucially, abort the surrounding ALS-shared tx (ADR-0001). For
    // tenant actions we leave `actorUserId` null and stash the tenant
    // identity in `metadata` so PDPA / forensics can still trace.
    const isTenant = user.typ === 'liff';
    const actorUserId = isTenant ? null : user.sub;
    // `Prisma.InputJsonObject` (not `Record<string, unknown>`) — Prisma's
    // generated `Json` field type rejects looser shapes because `unknown`
    // could hide non-serialisable values (functions, symbols). The plain
    // `{}` literal previously inferred narrowly enough to slip through;
    // with our two-branch object literal we have to type it explicitly.
    const metadata: Prisma.InputJsonObject = isTenant
      ? { actorTenantId: user.sub, actorLineUserId: user.lineUserId }
      : {};

    return next.handle().pipe(
      mergeMap(async (value) => {
        try {
          await prisma.auditLog.create({
            data: {
              companyId: user.companyId,
              actorUserId,
              action: `${req.method} ${req.routeOptions?.url ?? req.url}`,
              resource: deriveResource(req.url),
              resourceId: null,
              metadata,
              ipAddress: ip,
              userAgent,
            },
          });
        } catch (err) {
          this.logger.error(
            `Failed to write audit_log for ${req.method} ${req.url}: ${(err as Error).message}`,
          );
        }
        return value;
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
