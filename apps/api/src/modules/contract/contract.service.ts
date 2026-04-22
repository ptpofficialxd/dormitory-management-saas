import { type Prisma, getTenantContext, prisma } from '@dorm/db';
import type {
  Contract,
  CreateContractInput,
  ListContractsQuery,
  UpdateContractInput,
} from '@dorm/shared/zod';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { type CursorPage, buildCursorPage, decodeCursor } from '../../common/util/cursor.util.js';

/**
 * Contract = rental agreement between a Tenant and a Unit.
 *
 * Money semantics: `rentAmount` and `depositAmount` are SNAPSHOTS taken at
 * signing. Bumping `unit.baseRent` later does not retroactively raise the
 * tenant's bill — they keep paying the contracted rate until renewal. This
 * mirrors how Thai dorm leases work in practice and avoids surprise charges.
 *
 * Date semantics: `endDate` is INCLUSIVE — `[2026-01-01, 2026-12-31]` covers
 * EOD on Dec 31. `endDate IS NULL` means open-ended (month-to-month, the
 * common case). Overlap detection uses `<=` / `>=` accordingly.
 *
 * Status state-machine (MVP — any → any allowed; staff override):
 *   draft → active        (signing)
 *   active → ended        (natural expiry)
 *   active → terminated   (early break — deposit handling differs)
 *   ended/terminated → *  (re-opening for corrections — overlap re-checked)
 *
 * No DELETE — Contract cascades into Invoice/Payment. Use `terminated` for
 * early break, `ended` for natural expiry. The row stays for billing audit.
 *
 * Cross-tenant guards (RLS is per-table, NOT cross-table FK):
 *   - `unitId` must be visible under current tenant (else → 400)
 *   - `tenantId` must be visible under current tenant (else → 400)
 */
@Injectable()
export class ContractService {
  /** Cursor-paginated list with optional unitId/tenantId/status filters. */
  async list(query: ListContractsQuery): Promise<CursorPage<Contract>> {
    const { cursor, limit, unitId, tenantId, status } = query;
    const decoded = cursor ? decodeCursor(cursor) : null;

    const baseWhere: Prisma.ContractWhereInput = {};
    if (unitId) baseWhere.unitId = unitId;
    if (tenantId) baseWhere.tenantId = tenantId;
    if (status) baseWhere.status = status;

    const where: Prisma.ContractWhereInput = decoded
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

    const rows = await prisma.contract.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return buildCursorPage(rows as unknown as Contract[], limit);
  }

  async getById(id: string): Promise<Contract> {
    const row = await prisma.contract.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Contract ${id} not found`);
    return row as unknown as Contract;
  }

  /**
   * Create a contract. Three pre-flight checks BEFORE the INSERT so we never
   * leave a half-validated row that audit logs would have to apologise for:
   *   1. unit visible under current tenant (RLS hides → 400)
   *   2. tenant visible under current tenant (RLS hides → 400)
   *   3. no overlapping draft/active contract on the same unit
   */
  async create(input: CreateContractInput): Promise<Contract> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on create');
    }

    await Promise.all([
      this.assertUnitVisible(input.unitId),
      this.assertTenantVisible(input.tenantId),
    ]);

    await this.assertNoOverlap({
      unitId: input.unitId,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      excludeId: null,
    });

    const row = await prisma.contract.create({
      data: {
        companyId: ctx.companyId,
        unitId: input.unitId,
        tenantId: input.tenantId,
        startDate: new Date(input.startDate),
        endDate: input.endDate ? new Date(input.endDate) : null,
        rentAmount: input.rentAmount,
        depositAmount: input.depositAmount,
        // status defaults to 'draft' in Prisma — explicit here for clarity.
        status: 'draft',
        notes: input.notes ?? null,
      },
    });
    return row as unknown as Contract;
  }

  /**
   * Update is intentionally narrow: status, endDate, notes only. unitId /
   * tenantId / rentAmount / depositAmount are SNAPSHOTS at signing — to change
   * those you terminate this contract and create a new one.
   *
   * Overlap re-check fires whenever the FINAL state would be active-like
   * (`draft`/`active`) AND something material changed (endDate moved OR status
   * transitioned INTO active-like from ended/terminated). Skipping the check
   * on `active → ended` is safe because we're closing the window, not opening.
   */
  async update(id: string, input: UpdateContractInput): Promise<Contract> {
    const existing = await this.getById(id);

    const newStatus = input.status ?? existing.status;
    const wasActiveLike = existing.status === 'draft' || existing.status === 'active';
    const isActiveLike = newStatus === 'draft' || newStatus === 'active';
    const datesChanged = input.endDate !== undefined;

    if (isActiveLike && (datesChanged || !wasActiveLike)) {
      // existing.startDate is `string` per the Zod-typed Contract — we cast
      // through the Prisma row at boundary so it's actually a Date here. The
      // overlap helper accepts ISO strings, so format both consistently.
      const existingStart = toIsoDate(existing.startDate);
      const newEnd =
        input.endDate !== undefined
          ? input.endDate
          : existing.endDate
            ? toIsoDate(existing.endDate)
            : null;

      await this.assertNoOverlap({
        unitId: existing.unitId,
        startDate: existingStart,
        endDate: newEnd,
        excludeId: id,
      });
    }

    const row = await prisma.contract.update({
      where: { id },
      data: {
        status: input.status,
        // endDate `undefined` = no-op. We don't model "clear endDate" via PATCH
        // because flipping a fixed-term contract to open-ended mid-flight is
        // unusual; staff should terminate + recreate.
        ...(input.endDate !== undefined ? { endDate: new Date(input.endDate) } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });
    return row as unknown as Contract;
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

  private async assertTenantVisible(tenantId: string): Promise<void> {
    const exists = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!exists) {
      throw new BadRequestException({
        error: 'InvalidTenantId',
        message: `Tenant ${tenantId} does not exist or is not accessible`,
      });
    }
  }

  /**
   * Reject overlapping draft/active contracts on the same unit. Two intervals
   * `[a1, a2]` and `[b1, b2]` overlap iff `a1 <= b2 AND b1 <= a2`. NULL endDate
   * is treated as +infinity on either side.
   *
   * `excludeId` lets `update()` skip the row being modified (otherwise a no-op
   * PATCH would always self-overlap).
   */
  private async assertNoOverlap(args: {
    unitId: string;
    startDate: string; // YYYY-MM-DD
    endDate: string | null; // YYYY-MM-DD or null = open-ended
    excludeId: string | null;
  }): Promise<void> {
    const newStart = new Date(args.startDate);
    const newEnd = args.endDate ? new Date(args.endDate) : null;

    // Existing overlaps the new window iff:
    //   existing.startDate <= newEnd  (existing starts on/before new ends)
    //   AND existing.endDate >= newStart  (existing ends on/after new starts)
    // With NULL endDate treated as +infinity on the relevant side.
    const startCondition: Prisma.ContractWhereInput = newEnd ? { startDate: { lte: newEnd } } : {}; // newEnd = +inf → existing.startDate ≤ +inf is always true

    const endCondition: Prisma.ContractWhereInput = {
      OR: [{ endDate: null }, { endDate: { gte: newStart } }],
    };

    const overlap = await prisma.contract.findFirst({
      where: {
        ...(args.excludeId ? { id: { not: args.excludeId } } : {}),
        unitId: args.unitId,
        status: { in: ['draft', 'active'] },
        AND: [startCondition, endCondition],
      },
      select: { id: true },
    });

    if (overlap) {
      throw new ConflictException({
        error: 'ContractOverlap',
        message: `Unit ${args.unitId} already has a draft/active contract overlapping this period`,
      });
    }
  }
}

/**
 * Format a JS Date (or pass-through string) as `YYYY-MM-DD`. Prisma `@db.Date`
 * columns return Date objects in UTC midnight; slicing the ISO string gives
 * the calendar date back without timezone drift for our Asia/Bangkok use case
 * (date-only fields aren't time-zone-sensitive).
 */
function toIsoDate(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}
