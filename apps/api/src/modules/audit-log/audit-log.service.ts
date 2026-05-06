import { Prisma, getTenantContext, prisma } from '@dorm/db';
import type { AuditLog, ListAuditLogsInput } from '@dorm/shared/zod';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { type CursorPage, buildCursorPage, decodeCursor } from '../../common/util/cursor.util.js';

/**
 * Audit log read service (Task #119).
 *
 * Backs `GET /c/:slug/audit-logs`. RLS scopes every query to the active
 * company via the `companyId = app_current_company_id()` policy — no need
 * to pass companyId explicitly here, the `prisma` proxy + TenantContext
 * interceptor handle it.
 *
 * Pagination: keyset on `(createdAt DESC, id DESC)` — same shape as the
 * `audit_log_company_id_created_at_idx` index added at table creation.
 * The cursor encodes `(createdAt, id)` of the boundary row; clients pass
 * it back to fetch the next page.
 *
 * Filters AND together. Date range is half-open `[fromDate, toDate)` to
 * match how clients typically think about "today" / "this week".
 *
 * NOT enforced here (Phase 1):
 *   - Plan-tier `auditRetentionDays` window. SAAS-001 limits free tier to
 *     7 days of audit visibility; we'd cap `fromDate` to `max(input.fromDate,
 *     now - retentionDays)` once entitlements are passed in. Skipped in v1
 *     so the read endpoint is testable without the entitlement plumbing —
 *     ship → wire entitlement later.
 */
@Injectable()
export class AuditLogReadService {
  /**
   * List audit log rows matching `input`. Returns a cursor page —
   * `nextCursor: null` means "no more rows".
   */
  async list(input: ListAuditLogsInput): Promise<CursorPage<AuditLog>> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on audit-log list');
    }

    const where: Prisma.AuditLogWhereInput = {};
    if (input.actorUserId) where.actorUserId = input.actorUserId;
    if (input.resource) where.resource = input.resource;
    if (input.action) where.action = input.action;

    if (input.fromDate || input.toDate) {
      where.createdAt = {};
      if (input.fromDate) where.createdAt.gte = new Date(input.fromDate);
      if (input.toDate) where.createdAt.lt = new Date(input.toDate);
    }

    // Cursor pagination — keyset on (createdAt DESC, id DESC). The OR
    // captures rows STRICTLY older than the boundary OR same-timestamp
    // rows with an earlier id (UUIDs are not chronological so this is
    // only deterministic per session — but it's stable for the test).
    if (input.cursor) {
      const decoded = decodeCursor(input.cursor);
      const boundary = new Date(decoded.createdAt);
      where.OR = [{ createdAt: { lt: boundary } }, { createdAt: boundary, id: { lt: decoded.id } }];
    }

    // take = limit + 1 → buildCursorPage() detects "is there a next page"
    // without an extra COUNT round-trip.
    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    });

    const page = buildCursorPage(rows, input.limit);
    return {
      items: page.items.map((r) => this.toWire(r)),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Convert the raw Prisma row into the wire shape — `metadata` is JSONB
   * on the DB side (Prisma `JsonValue`), the wire schema expects
   * `Record<string, unknown>`. We coerce defensively: anything that isn't
   * a plain object becomes `{}` so the parsed Zod response is always valid.
   */
  private toWire(row: {
    id: string;
    companyId: string;
    actorUserId: string | null;
    action: string;
    resource: string;
    resourceId: string | null;
    metadata: Prisma.JsonValue;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
  }): AuditLog {
    return {
      id: row.id,
      companyId: row.companyId,
      actorUserId: row.actorUserId,
      action: row.action,
      resource: row.resource,
      resourceId: row.resourceId,
      metadata: this.coerceMetadata(row.metadata),
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private coerceMetadata(raw: Prisma.JsonValue): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    return {};
  }
}
