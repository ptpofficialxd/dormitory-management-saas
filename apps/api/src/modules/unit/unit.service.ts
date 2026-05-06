import { type Prisma, getTenantContext, prisma } from '@dorm/db';
import type { CreateUnitInput, ListUnitsQuery, Unit, UpdateUnitInput } from '@dorm/shared/zod';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { type CursorPage, buildCursorPage, decodeCursor } from '../../common/util/cursor.util.js';
import { softWarnPlanLimit } from '../../common/util/plan-limit.util.js';

/**
 * Unit (room) lifecycle. RLS handles cross-tenant isolation transparently;
 * this service only adds the things RLS DOESN'T do:
 *   - Cross-table FK validation (RLS is per-table — `unit.property_id` could
 *     legally point to ANY company's property unless we explicitly verify).
 *   - Decimal serialisation (`baseRent` / `sizeSqm` arrive as strings on the
 *     wire; Prisma accepts strings into `Decimal` columns directly, but we
 *     normalise at the boundary so the response shape is predictable).
 *   - Prisma error → HTTP envelope mapping (P2002 → 409, P2025 → 404).
 *
 * DELETE intentionally absent in MVP — Unit cascades into Contract / Meter /
 * Reading / Invoice. A safer "retire" path (soft delete + status=maintenance)
 * is the Phase 2 design.
 */
@Injectable()
export class UnitService {
  /**
   * Cursor-paginated list with optional `propertyId` + `status` filters.
   * Both filters AND-combine; absence = unfiltered (still RLS-scoped).
   */
  async list(query: ListUnitsQuery): Promise<CursorPage<Unit>> {
    const { cursor, limit, propertyId, status } = query;
    const decoded = cursor ? decodeCursor(cursor) : null;

    const baseWhere: Prisma.UnitWhereInput = {};
    if (propertyId) baseWhere.propertyId = propertyId;
    if (status) baseWhere.status = status;

    const where: Prisma.UnitWhereInput = decoded
      ? {
          AND: [
            baseWhere,
            {
              OR: [
                { createdAt: { lt: new Date(decoded.createdAt) } },
                { createdAt: new Date(decoded.createdAt), id: { lt: decoded.id } },
              ],
            },
          ],
        }
      : baseWhere;

    const rows = await prisma.unit.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return buildCursorPage(rows as unknown as Unit[], limit);
  }

  async getById(id: string): Promise<Unit> {
    const row = await prisma.unit.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Unit ${id} not found`);
    return row as unknown as Unit;
  }

  /**
   * Create a unit under a property. The propertyId pre-check is the critical
   * cross-tenant guard — RLS only filters per-table, so an attacker could
   * legally INSERT a unit pointing to another company's property unless we
   * verify the property is visible under the current tenant context.
   *
   * Slug-style uniqueness is `(propertyId, unitNumber)` — duplicate room
   * numbers within the same building map to a 409 with a recognisable error
   * code so the admin UI can surface "this room number is taken" inline.
   */
  async create(input: CreateUnitInput): Promise<Unit> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on create');
    }

    await this.assertPropertyVisible(input.propertyId);

    try {
      const row = await prisma.unit.create({
        data: {
          companyId: ctx.companyId,
          propertyId: input.propertyId,
          unitNumber: input.unitNumber,
          // Schema default is 1 in Zod, but Prisma also defaults — pass
          // through anyway so the wire shape and the row shape match.
          floor: input.floor ?? 1,
          baseRent: input.baseRent,
          sizeSqm: input.sizeSqm ?? null,
          notes: input.notes ?? null,
        },
      });

      // Plan-limit soft warn (Task #122). Fire-and-forget — we count AFTER
      // the create so the new row is included; helper emits a dedup'd
      // `plan.limit_exceeded` audit row if `count > getPlanLimits(plan).units`.
      // v1 is warn-only; Phase 1 (SAAS-004) swaps for hard 402.
      const unitCount = await prisma.unit.count({
        where: { companyId: ctx.companyId },
      });
      void softWarnPlanLimit({
        companyId: ctx.companyId,
        resource: 'units',
        count: unitCount,
      });

      return row as unknown as Unit;
    } catch (err) {
      if (isUniqueConstraintError(err, 'unitNumber')) {
        throw new ConflictException({
          error: 'UnitNumberTaken',
          message: `Unit number "${input.unitNumber}" already exists in this property`,
        });
      }
      throw err;
    }
  }

  /**
   * Partial update. If `propertyId` is being changed (rare — units don't
   * usually move between buildings) we re-run the visibility check on the
   * NEW property. Status transitions are unconstrained in MVP — staff have
   * legitimate reasons for any → any (e.g. flipping to `maintenance` mid-term
   * after a flood).
   */
  async update(id: string, input: UpdateUnitInput): Promise<Unit> {
    await this.getById(id);

    if (input.propertyId !== undefined) {
      await this.assertPropertyVisible(input.propertyId);
    }

    try {
      const row = await prisma.unit.update({
        where: { id },
        data: {
          propertyId: input.propertyId,
          unitNumber: input.unitNumber,
          floor: input.floor,
          baseRent: input.baseRent,
          status: input.status,
          // Distinguish "clear" (null) from "no-op" (undefined) for nullables.
          ...(input.sizeSqm !== undefined ? { sizeSqm: input.sizeSqm } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      });
      return row as unknown as Unit;
    } catch (err) {
      if (isUniqueConstraintError(err, 'unitNumber')) {
        throw new ConflictException({
          error: 'UnitNumberTaken',
          message: `Unit number "${input.unitNumber}" already exists in this property`,
        });
      }
      throw err;
    }
  }

  /**
   * Verify the property is visible to the current tenant. RLS hides rows
   * from other companies → `findUnique` returns null → we raise 400 (not
   * 404, because the client knowingly supplied a foreign id — we don't want
   * to leak existence of properties they can't see).
   */
  private async assertPropertyVisible(propertyId: string): Promise<void> {
    const exists = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true },
    });
    if (!exists) {
      throw new BadRequestException({
        error: 'InvalidPropertyId',
        message: `Property ${propertyId} does not exist or is not accessible`,
      });
    }
  }
}

/**
 * Detect Prisma P2002 unique-constraint violations on a specific column.
 * Kept loose-typed so we don't drag the full Prisma error union into apps.
 */
function isUniqueConstraintError(err: unknown, column: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== 'P2002') return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.some((t) => String(t).includes(column));
  return typeof target === 'string' && target.includes(column);
}
