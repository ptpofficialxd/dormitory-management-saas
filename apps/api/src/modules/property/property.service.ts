import { getTenantContext, prisma } from '@dorm/db';
import type {
  CreatePropertyInput,
  ListPropertiesQuery,
  Property,
  UpdatePropertyInput,
} from '@dorm/shared/zod';
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { type CursorPage, buildCursorPage, decodeCursor } from '../../common/util/cursor.util.js';

/**
 * Property = a building/site owned by a company. Manager-only mutations; any
 * authenticated admin can list/read.
 *
 * RLS is enforced by `TenantContextInterceptor` (see `app.module.ts`) — every
 * Prisma call below runs inside a tx with `SET LOCAL app.company_id = …`, so
 * we don't manually filter `where: { companyId }` (RLS would fail-closed if we
 * accidentally crossed tenants). The exception is INSERT: RLS WITH CHECK still
 * needs the value populated, so we pull it from the active tenant context.
 *
 * Delete is intentionally NOT exposed in MVP — Property cascades into Unit /
 * Contract / Meter / Reading, which would erase month-of-data if tapped by
 * accident. If staff really wants to retire a building, archive flag is the
 * Phase 2 path (out of scope here).
 */
@Injectable()
export class PropertyService {
  /**
   * Cursor-paginated list, ordered by `(createdAt DESC, id DESC)`. The double
   * sort key is required because cursor decoding compares both fields — UUID
   * v7 isn't strictly monotonic across processes so two rows with identical
   * `createdAt` would otherwise produce non-deterministic ordering.
   */
  async list(query: ListPropertiesQuery): Promise<CursorPage<Property>> {
    const { cursor, limit } = query;
    const decoded = cursor ? decodeCursor(cursor) : null;

    const rows = await prisma.property.findMany({
      where: decoded
        ? {
            OR: [
              { createdAt: { lt: new Date(decoded.createdAt) } },
              { createdAt: new Date(decoded.createdAt), id: { lt: decoded.id } },
            ],
          }
        : undefined,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // +1 sentinel to detect "is there a next page" without a COUNT round-trip.
      take: limit + 1,
    });

    return buildCursorPage(rows as unknown as Property[], limit);
  }

  /** Fetch one. 404 on miss — RLS may have hidden it from the wrong tenant. */
  async getById(id: string): Promise<Property> {
    const row = await prisma.property.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Property ${id} not found`);
    return row as unknown as Property;
  }

  /**
   * Create a property. We stamp `companyId` from the tenant context (set by
   * the JWT guard pipeline) — clients cannot supply it. Slug uniqueness is
   * enforced per-company by the DB unique index (`@@unique([companyId, slug])`).
   * We translate the Prisma P2002 into a 409 so the client UI can surface a
   * "slug taken" inline error instead of a generic 500.
   */
  async create(input: CreatePropertyInput): Promise<Property> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      // Should be unreachable: TenantContextInterceptor only fires for
      // authenticated requests. If we hit this, the wiring is broken.
      throw new InternalServerErrorException('Tenant context missing on create');
    }

    try {
      const row = await prisma.property.create({
        data: {
          companyId: ctx.companyId,
          slug: input.slug,
          name: input.name,
          address: input.address ?? null,
        },
      });
      return row as unknown as Property;
    } catch (err) {
      if (isUniqueConstraintError(err, 'companyId_slug')) {
        throw new ConflictException({
          error: 'PropertySlugTaken',
          message: `A property with slug "${input.slug}" already exists in this company`,
        });
      }
      throw err;
    }
  }

  /**
   * Partial update. Only fields present in the input get written — Prisma's
   * `update` ignores undefined keys. We re-issue a 404 if the row doesn't
   * exist (or RLS hid it) instead of letting Prisma's generic P2025 surface.
   */
  async update(id: string, input: UpdatePropertyInput): Promise<Property> {
    // Pre-flight read so we can 404 with a clean message before attempting the
    // write. `update` would also throw P2025, but the message is opaque and
    // the audit log would already have a half-failed mutation logged.
    await this.getById(id);

    try {
      const row = await prisma.property.update({
        where: { id },
        data: {
          slug: input.slug,
          name: input.name,
          // address: undefined → no-op; null → explicit clear.
          ...(input.address !== undefined ? { address: input.address } : {}),
        },
      });
      return row as unknown as Property;
    } catch (err) {
      if (isUniqueConstraintError(err, 'companyId_slug')) {
        throw new ConflictException({
          error: 'PropertySlugTaken',
          message: `A property with slug "${input.slug}" already exists in this company`,
        });
      }
      throw err;
    }
  }
}

/**
 * Detect Prisma P2002 unique-constraint violations targeting a specific
 * compound index (Prisma reports the index column list in `meta.target`).
 * Kept loose-typed so we don't drag the full Prisma error union into apps.
 */
function isUniqueConstraintError(err: unknown, indexFragment: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== 'P2002') return false;
  const target = e.meta?.target;
  if (Array.isArray(target))
    return target.some((t) => String(t).includes(indexFragment.split('_')[0] ?? ''));
  return typeof target === 'string' && target.includes(indexFragment);
}
