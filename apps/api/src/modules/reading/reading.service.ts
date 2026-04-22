import { type Prisma, getTenantContext, prisma } from '@dorm/db';
import { sub as moneySub, toStorage } from '@dorm/shared/money';
import type {
  CreateReadingInput,
  ListReadingsQuery,
  Reading,
  UpdateReadingInput,
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
 * Reading = monthly meter reading. The service does the bookkeeping the API
 * client shouldn't have to think about:
 *
 *   1. **Resolves `valuePrevious` server-side** by looking up the most recent
 *      reading on this meter from a STRICTLY EARLIER period — the client only
 *      submits what the meter shows today (`valueCurrent`). First reading
 *      defaults to `0.00`. We compare period strings lexicographically; that
 *      works because they're all `YYYY-MM` and ASCII-sortable.
 *
 *   2. **Computes `consumption` = `valueCurrent − valuePrevious`** via
 *      `decimal.js` (NEVER `number`) and stores both the inputs AND the
 *      derived value. Recomputing from history later would silently drift if
 *      a past reading is corrected — see CLAUDE.md §3.3.
 *
 *   3. **Rejects `consumption < 0`** — meters don't run backwards. If a meter
 *      gets replaced, the operator must use the maintenance flow (Phase 2)
 *      rather than file a negative reading. We surface a 400 with a code
 *      `NegativeConsumption` so the UI can render a tailored message.
 *
 *   4. **Idempotency on `(meterId, period)`** — DB has `@@unique` on the pair,
 *      so a P2002 from Prisma maps to 409 `ReadingAlreadyExists`. The slip
 *      / reading workflows are routinely retried by mobile clients on flaky
 *      networks, so this matters.
 *
 *   5. **Cross-tenant guard**: `meterId` must be visible under the current
 *      tenant — RLS is per-table; without this an attacker could attach a
 *      reading to a foreign company's meter (the FK target row is invisible
 *      to RLS but the INSERT itself isn't blocked).
 *
 * No DELETE — Reading is referenced by `InvoiceItem` once an invoice is
 * generated. Use a corrective PATCH (rare) or void the invoice.
 *
 * `readByUserId` is left null in MVP — the request-scoped user identity
 * isn't surfaced through the tenant context yet. Phase 2 will pull it from
 * `req.user` via a request-scoped provider.
 */
@Injectable()
export class ReadingService {
  /** Cursor-paginated list with optional `meterId` + `period` filters. */
  async list(query: ListReadingsQuery): Promise<CursorPage<Reading>> {
    const { cursor, limit, meterId, period } = query;
    const decoded = cursor ? decodeCursor(cursor) : null;

    const baseWhere: Prisma.ReadingWhereInput = {};
    if (meterId) baseWhere.meterId = meterId;
    if (period) baseWhere.period = period;

    const where: Prisma.ReadingWhereInput = decoded
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

    const rows = await prisma.reading.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return buildCursorPage(rows as unknown as Reading[], limit);
  }

  async getById(id: string): Promise<Reading> {
    const row = await prisma.reading.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Reading ${id} not found`);
    return row as unknown as Reading;
  }

  /**
   * Create a reading. Three things have to happen in order:
   *   1. Verify the meter is visible under current tenant (cross-table guard).
   *   2. Resolve `valuePrevious` from the latest STRICTLY EARLIER reading on
   *      this meter (defaults to `0.00` for the first ever reading).
   *   3. Compute `consumption` and reject if negative.
   *
   * The `(meterId, period)` unique constraint is the safety net — we don't
   * pre-check it because that races with concurrent inserts. We let Prisma
   * tell us via P2002.
   */
  async create(input: CreateReadingInput): Promise<Reading> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on create');
    }

    await this.assertMeterVisible(input.meterId);

    const valuePrevious = await this.resolveValuePrevious(input.meterId, input.period);
    const consumption = moneySub(input.valueCurrent, valuePrevious);
    if (consumption.isNegative()) {
      throw new BadRequestException({
        error: 'NegativeConsumption',
        message: `Reading ${input.valueCurrent} is below the previous reading ${valuePrevious} — meters do not run backwards`,
      });
    }

    try {
      const row = await prisma.reading.create({
        data: {
          companyId: ctx.companyId,
          meterId: input.meterId,
          period: input.period,
          valueCurrent: input.valueCurrent,
          valuePrevious,
          consumption: toStorage(consumption),
          photoKey: input.photoKey ?? null,
          // readAt defaults to now if omitted — staff sometimes record on a
          // delay, so we accept an explicit override.
          readAt: input.readAt ? new Date(input.readAt) : new Date(),
          // Will be populated from req.user once user context is wired through.
          readByUserId: null,
        },
      });
      return row as unknown as Reading;
    } catch (err) {
      if (isUniqueConstraintError(err, ['meter_id', 'period'])) {
        throw new ConflictException({
          error: 'ReadingAlreadyExists',
          message: `Meter ${input.meterId} already has a reading for ${input.period}`,
        });
      }
      throw err;
    }
  }

  /**
   * Patch is intentionally narrow: only valueCurrent / photoKey / readAt are
   * editable. If valueCurrent changes we recompute consumption AGAINST THE
   * STORED valuePrevious — re-resolving from history would defeat the audit
   * trail (the previous reading might have been corrected in the meantime,
   * which should NOT cascade into this row).
   *
   * We still reject negative consumption on the corrected value.
   */
  async update(id: string, input: UpdateReadingInput): Promise<Reading> {
    const existing = await this.getById(id);

    let nextConsumption: string | undefined;
    if (input.valueCurrent !== undefined) {
      const consumption = moneySub(input.valueCurrent, existing.valuePrevious);
      if (consumption.isNegative()) {
        throw new BadRequestException({
          error: 'NegativeConsumption',
          message: `Corrected reading ${input.valueCurrent} is below the previous reading ${existing.valuePrevious}`,
        });
      }
      nextConsumption = toStorage(consumption);
    }

    const row = await prisma.reading.update({
      where: { id },
      data: {
        ...(input.valueCurrent !== undefined ? { valueCurrent: input.valueCurrent } : {}),
        ...(nextConsumption !== undefined ? { consumption: nextConsumption } : {}),
        ...(input.photoKey !== undefined ? { photoKey: input.photoKey } : {}),
        ...(input.readAt !== undefined ? { readAt: new Date(input.readAt) } : {}),
      },
    });
    return row as unknown as Reading;
  }

  // -----------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------

  private async assertMeterVisible(meterId: string): Promise<void> {
    const exists = await prisma.meter.findUnique({
      where: { id: meterId },
      select: { id: true },
    });
    if (!exists) {
      throw new BadRequestException({
        error: 'InvalidMeterId',
        message: `Meter ${meterId} does not exist or is not accessible`,
      });
    }
  }

  /**
   * Latest reading STRICTLY before `period` on this meter, or `"0.00"` if
   * none exists. Period strings are `YYYY-MM` so lex-compare === time-compare.
   *
   * We pull only `valueCurrent` because that's what becomes the *next*
   * reading's `valuePrevious`. (Today's reading's "current" is tomorrow's
   * reading's "previous" — running odometer style.)
   */
  private async resolveValuePrevious(meterId: string, period: string): Promise<string> {
    const prior = await prisma.reading.findFirst({
      where: { meterId, period: { lt: period } },
      orderBy: { period: 'desc' },
      select: { valueCurrent: true },
    });
    if (!prior) return '0.00';
    // Prisma `Decimal` exposes `toString()` returning a normalised decimal
    // string — safe for round-tripping into another Decimal column.
    return (prior.valueCurrent as unknown as { toString(): string }).toString();
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
