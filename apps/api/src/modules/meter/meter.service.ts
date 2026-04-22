import { type Prisma, getTenantContext, prisma } from '@dorm/db';
import type { CreateMeterInput, ListMetersQuery, Meter, UpdateMeterInput } from '@dorm/shared/zod';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { type CursorPage, buildCursorPage, decodeCursor } from '../../common/util/cursor.util.js';

/**
 * Meter = water/electric meter physically installed on a Unit.
 *
 * Two big invariants enforced here:
 *   1. **One meter per `(unitId, kind)`** — the DB has `@@unique([unitId, kind])`
 *      so a P2002 from Prisma maps to 409 `MeterAlreadyExists`. The UI relies
 *      on this to render "Add water meter" / "Add electric meter" once each.
 *   2. **`ratePerUnit` is a SNAPSHOT in `Decimal(10,4)`** — Thai electric
 *      tariffs like `5.8124 THB/kWh` mustn't be rounded on storage. Bumping
 *      the rate later affects FUTURE readings only; the existing `Reading`
 *      rows already have `unitPrice` snapshot at the time they were captured.
 *
 * Cross-tenant guard: `unitId` must be visible under the current tenant —
 * RLS is per-table so without this an attacker could attach a meter to a
 * different company's unit (the FK target row is invisible to RLS but the
 * INSERT itself isn't blocked).
 *
 * No DELETE — Meter cascades into Reading; deleting a meter would orphan
 * historical billing data. Phase-2 design will introduce a "retired" status
 * on Meter so old fixtures can be hidden from the meter-reading workflow
 * without losing history.
 */
@Injectable()
export class MeterService {
  /** Cursor-paginated list with optional `unitId` + `kind` filters. */
  async list(query: ListMetersQuery): Promise<CursorPage<Meter>> {
    const { cursor, limit, unitId, kind } = query;
    const decoded = cursor ? decodeCursor(cursor) : null;

    const baseWhere: Prisma.MeterWhereInput = {};
    if (unitId) baseWhere.unitId = unitId;
    if (kind) baseWhere.kind = kind;

    const where: Prisma.MeterWhereInput = decoded
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

    const rows = await prisma.meter.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return buildCursorPage(rows as unknown as Meter[], limit);
  }

  async getById(id: string): Promise<Meter> {
    const row = await prisma.meter.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Meter ${id} not found`);
    return row as unknown as Meter;
  }

  /**
   * Create a meter. Cross-tenant guard runs first; the unique-violation path
   * is the common "operator clicked Add twice" case → 409 with a code the UI
   * can recognise inline.
   */
  async create(input: CreateMeterInput): Promise<Meter> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on create');
    }

    await this.assertUnitVisible(input.unitId);

    try {
      const row = await prisma.meter.create({
        data: {
          companyId: ctx.companyId,
          unitId: input.unitId,
          kind: input.kind,
          serialNo: input.serialNo ?? null,
          unitOfMeasure: input.unitOfMeasure,
          ratePerUnit: input.ratePerUnit,
        },
      });
      return row as unknown as Meter;
    } catch (err) {
      if (isUniqueConstraintError(err, ['unit_id', 'kind'])) {
        throw new ConflictException({
          error: 'MeterAlreadyExists',
          message: `Unit ${input.unitId} already has a ${input.kind} meter`,
        });
      }
      throw err;
    }
  }

  /**
   * Patch is intentionally narrow — `unitId` and `kind` are not editable
   * because moving a meter between units or kinds invalidates the entire
   * Reading history attached to it. To "move" a meter, retire (Phase 2) and
   * create a new one.
   */
  async update(id: string, input: UpdateMeterInput): Promise<Meter> {
    await this.getById(id);

    const row = await prisma.meter.update({
      where: { id },
      data: {
        // serialNo is nullable on the row but the input schema marks it
        // optional (no explicit null) — we treat undefined as no-op only.
        ...(input.serialNo !== undefined ? { serialNo: input.serialNo } : {}),
        ...(input.unitOfMeasure !== undefined ? { unitOfMeasure: input.unitOfMeasure } : {}),
        ...(input.ratePerUnit !== undefined ? { ratePerUnit: input.ratePerUnit } : {}),
      },
    });
    return row as unknown as Meter;
  }

  // -----------------------------------------------------------------
  // Private guards
  // -----------------------------------------------------------------

  private async assertUnitVisible(unitId: string): Promise<void> {
    const exists = await prisma.unit.findUnique({
      where: { id: unitId },
      select: { id: true },
    });
    if (!exists) {
      throw new BadRequestException({
        error: 'InvalidUnitId',
        message: `Unit ${unitId} does not exist or is not accessible`,
      });
    }
  }
}

/**
 * Detect Prisma P2002 unique-constraint violations on a specific column tuple.
 * `target` is either a string (single col) or string[] (composite). We accept
 * either ordering — Prisma sometimes reorders composite targets internally.
 */
function isUniqueConstraintError(err: unknown, columns: string[]): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== 'P2002') return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) return columns.every((c) => target.some((t) => String(t).includes(c)));
  return typeof target === 'string' && columns.every((c) => target.includes(c));
}
