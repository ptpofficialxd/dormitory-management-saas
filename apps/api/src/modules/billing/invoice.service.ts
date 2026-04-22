import { type Prisma, getTenantContext, prisma } from '@dorm/db';
import { addPeriod, assertPeriod, fromBangkok } from '@dorm/shared/date';
import { mul as moneyMul, sum as moneySum, toStorage } from '@dorm/shared/money';
import type {
  BatchAdditionalItem,
  BatchGenerateInvoicesInput,
  BatchGenerateInvoicesResult,
  BatchSkipReason,
  CreateInvoiceInput,
  Invoice,
  ListInvoicesQuery,
  UpdateInvoiceInput,
} from '@dorm/shared/zod';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { type CursorPage, buildCursorPage, decodeCursor } from '../../common/util/cursor.util.js';
import { PromptPayService } from './prompt-pay.service.js';

/**
 * Invoice = monthly bill for a Contract+Period. The service owns the
 * money math, the state-machine guards, and the batch-generation pipeline.
 *
 * Money rules (CLAUDE.md §3.3, ADR-0005):
 *   - All arithmetic flows through `decimal.js` via `@dorm/shared/money`
 *     (`mul`, `sum`). NEVER `number` / `Float`.
 *   - `lineTotal = quantity × unitPrice`, clamped to 2dp HALF_UP at storage.
 *   - `subtotal = sum(lineTotals)`. `total = subtotal` in MVP (no tax / no
 *     discount). The columns are kept separate so Phase 2 can layer them in
 *     without a schema migration.
 *
 * Status state-machine (per Zod schema docs):
 *   draft → issued       (via PATCH /invoices/:id/issue)
 *   issued → partially_paid | paid   (via Payment.confirm — Task #27)
 *   * → void             (via PATCH /invoices/:id/void)
 *   issued → overdue     (Phase 2 cron — not implemented in MVP)
 *
 * Batch generation skip rules (Ice-confirmed):
 *   - Inactive / missing contract → `inactive_contract` / `no_active_contract`
 *   - Existing invoice for `(contractId, period)` → `duplicate_invoice`
 *   - Meter exists but Reading missing for period → `missing_water_reading` /
 *     `missing_electric_reading`
 *   - Meter doesn't exist on unit → that line item is silently skipped (no
 *     invoice-level skip; not every unit has both meters in legacy buildings)
 *
 * Cross-tenant guards:
 *   - `contractId` on single-invoice POST → must be visible (RLS-per-table)
 *   - Batch sources contracts via RLS-scoped findMany so nothing leaks
 */
@Injectable()
export class InvoiceService {
  constructor(private readonly promptPay: PromptPayService) {}

  // ---------------------------------------------------------------
  // Read paths
  // ---------------------------------------------------------------

  /** Cursor-paginated list with optional `status` / `period` / `tenantId` filters. */
  async list(query: ListInvoicesQuery): Promise<CursorPage<Invoice>> {
    const { cursor, limit, status, period, tenantId } = query;
    const decoded = cursor ? decodeCursor(cursor) : null;

    const baseWhere: Prisma.InvoiceWhereInput = {};
    if (status) baseWhere.status = status;
    if (period) baseWhere.period = period;
    if (tenantId) baseWhere.tenantId = tenantId;

    const where: Prisma.InvoiceWhereInput = decoded
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

    const rows = await prisma.invoice.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      // List view excludes items (heavy) — clients use getById for the detail page.
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });

    return buildCursorPage(rows as unknown as Invoice[], limit);
  }

  async getById(id: string): Promise<Invoice> {
    const row = await prisma.invoice.findUnique({
      where: { id },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!row) throw new NotFoundException(`Invoice ${id} not found`);
    return row as unknown as Invoice;
  }

  // ---------------------------------------------------------------
  // Write paths — single invoice
  // ---------------------------------------------------------------

  /**
   * Create a one-off invoice (admin-driven, e.g. ad-hoc charges that don't
   * fit the batch pipeline). Items are user-supplied; the service just
   * computes `lineTotal`, `subtotal`, `total` and writes everything in one
   * Prisma nested-write transaction.
   */
  async create(input: CreateInvoiceInput): Promise<Invoice> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on create');
    }

    const contract = await prisma.contract.findUnique({
      where: { id: input.contractId },
      select: { id: true, unitId: true, tenantId: true },
    });
    if (!contract) {
      throw new BadRequestException({
        error: 'InvalidContractId',
        message: `Contract ${input.contractId} does not exist or is not accessible`,
      });
    }

    const itemsWithTotals = input.items.map((it, idx) => ({
      kind: it.kind,
      description: it.description,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      lineTotal: toStorage(moneyMul(it.quantity, it.unitPrice)),
      readingId: it.readingId ?? null,
      sortOrder: it.sortOrder ?? idx,
    }));
    const subtotal = toStorage(moneySum(itemsWithTotals.map((i) => i.lineTotal)));

    try {
      const row = await prisma.invoice.create({
        data: {
          companyId: ctx.companyId,
          contractId: contract.id,
          unitId: contract.unitId,
          tenantId: contract.tenantId,
          period: input.period,
          // issueDate is required by Prisma; set to NOW for drafts so list
          // ordering is sensible. Re-stamped to a fresh NOW on issue().
          issueDate: new Date(),
          dueDate: new Date(input.dueDate),
          subtotal,
          total: subtotal, // No tax / discount in MVP — see Money rules above.
          status: 'draft',
          items: {
            create: itemsWithTotals.map((it) => ({
              companyId: ctx.companyId,
              ...it,
            })),
          },
        },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      });
      return row as unknown as Invoice;
    } catch (err) {
      if (isUniqueConstraintError(err, ['contract_id', 'period'])) {
        throw new ConflictException({
          error: 'DuplicateInvoice',
          message: `Contract ${contract.id} already has an invoice for ${input.period}`,
        });
      }
      throw err;
    }
  }

  /**
   * Patch — narrow to `dueDate` only. Status mutations go through dedicated
   * endpoints (`issue`, `void`, and Payment.confirm) so the state machine
   * isn't sidestepped via a generic PATCH.
   *
   * `dueDate` can move forward (extension) or backward (admin correction)
   * pre-`paid`. Once paid, dueDate is informational only — we still allow
   * patches for reconciliation, but the audit log captures the change.
   */
  async update(id: string, input: UpdateInvoiceInput): Promise<Invoice> {
    await this.getById(id);

    if (input.status !== undefined) {
      // Refuse generic status PATCH — direct callers must use the typed
      // endpoints. We surface a 400 (not 409) because this is a CONTRACT
      // violation by the API consumer, not a state-machine conflict.
      throw new BadRequestException({
        error: 'StatusNotPatchable',
        message: 'Use POST /invoices/:id/issue, /void, or Payment.confirm to change invoice status',
      });
    }

    const row = await prisma.invoice.update({
      where: { id },
      data: {
        ...(input.dueDate !== undefined ? { dueDate: new Date(input.dueDate) } : {}),
      },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    return row as unknown as Invoice;
  }

  /**
   * Issue a draft invoice — generates the PromptPay payload, stamps a fresh
   * `issueDate`, flips status to `issued`. Idempotent on `issued` (no-op +
   * 200) per Zod schema doc; refuses on any other status.
   */
  async issue(id: string): Promise<Invoice> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on issue');
    }

    const existing = await this.getById(id);
    if (existing.status === 'issued') {
      // Idempotent — return as-is. Caller might be retrying after a flaky
      // network round-trip; we MUST NOT regenerate `promptPayRef` because
      // that would invalidate any QR the tenant already scanned.
      return existing;
    }
    if (existing.status !== 'draft') {
      throw new ConflictException({
        error: 'InvoiceNotDraft',
        message: `Cannot issue invoice in status "${existing.status}" (only draft → issued)`,
      });
    }

    const company = await prisma.company.findUnique({
      where: { id: ctx.companyId },
      select: { promptPayId: true },
    });
    if (!company?.promptPayId) {
      throw new BadRequestException({
        error: 'PromptPayNotConfigured',
        message: 'Company has no PromptPay ID configured — set it before issuing invoices',
      });
    }

    const promptPayRef = this.promptPay.buildPayload({
      promptPayId: company.promptPayId,
      amount: existing.total,
    });

    const row = await prisma.invoice.update({
      where: { id },
      data: {
        status: 'issued',
        issueDate: new Date(),
        promptPayRef,
      },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    return row as unknown as Invoice;
  }

  /**
   * Void an invoice. Allowed from any pre-`paid` status; refuses on `paid`
   * (use a refund / credit-note flow in Phase 1+) or already-`void`.
   *
   * `reason` is captured by the AuditLogInterceptor from the request body —
   * the column itself doesn't exist on Invoice (audit log is the system of
   * record for "why").
   */
  async void(id: string, reason: string): Promise<Invoice> {
    const existing = await this.getById(id);
    if (existing.status === 'void') {
      // Idempotent — same reasoning as issue(): caller might be retrying.
      return existing;
    }
    if (existing.status === 'paid') {
      throw new ConflictException({
        error: 'InvoicePaid',
        message: 'Cannot void a paid invoice — use a refund flow instead',
      });
    }

    // Reason length / non-empty already validated by Zod at the controller
    // boundary. We accept it here purely so the audit interceptor sees it
    // pass through — no on-Invoice mutation beyond the status flip.
    void reason;

    const row = await prisma.invoice.update({
      where: { id },
      data: { status: 'void' },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    return row as unknown as Invoice;
  }

  // ---------------------------------------------------------------
  // Batch generation
  // ---------------------------------------------------------------

  /**
   * Batch-generate draft invoices for every active contract in a period.
   *
   * Two-phase flow:
   *   1. Plan — pull active contracts, find existing invoices, find readings,
   *      and produce a per-contract decision (`generate` | `skip + reason`).
   *   2. Apply — for each `generate`, run a nested-write `invoice.create`
   *      with all items in one transaction. We do NOT wrap the entire batch
   *      in a single transaction: a single bad row should not roll back the
   *      good rows. The skip list is the audit trail.
   *
   * `dueDate` = day-N of the FOLLOWING period (Thai dorm convention: the
   * April bill goes out in early May, due day 5 of May). `dueDayOfMonth` is
   * clamped 1-28 in Zod to dodge the Feb-30 trap.
   */
  async createBatch(input: BatchGenerateInvoicesInput): Promise<BatchGenerateInvoicesResult> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on batch');
    }

    const period = assertPeriod(input.period);
    const dueDate = this.computeDueDate(period, input.dueDayOfMonth);

    // Pull all in-scope contracts. RLS handles per-tenant isolation; we add
    // an optional propertyId filter via the unit relation.
    const contracts = await prisma.contract.findMany({
      where: {
        ...(input.propertyId ? { unit: { propertyId: input.propertyId } } : {}),
      },
      select: {
        id: true,
        unitId: true,
        tenantId: true,
        rentAmount: true,
        status: true,
        unit: { select: { unitNumber: true } },
      },
    });

    if (contracts.length === 0) {
      return { generatedInvoiceIds: [], skipped: [] };
    }

    // Pull existing invoices in one shot — `(contractId, period)` lookup,
    // so a Map is faster than per-contract roundtrips.
    const contractIds = contracts.map((c) => c.id);
    const existingInvoices = await prisma.invoice.findMany({
      where: { contractId: { in: contractIds }, period },
      select: { contractId: true },
    });
    const existingSet = new Set(existingInvoices.map((i) => i.contractId));

    // Pull all meters for these units, plus all readings for the period —
    // again, one roundtrip avoids N+1 over a 40-room dorm.
    const unitIds = contracts.map((c) => c.unitId);
    const meters = await prisma.meter.findMany({
      where: { unitId: { in: unitIds } },
      select: { id: true, unitId: true, kind: true, ratePerUnit: true, unitOfMeasure: true },
    });
    const readings = await prisma.reading.findMany({
      where: { meterId: { in: meters.map((m) => m.id) }, period },
      select: { id: true, meterId: true, consumption: true },
    });
    const readingByMeterId = new Map(readings.map((r) => [r.meterId, r]));

    // Group meters by unitId for O(1) lookup per contract.
    const metersByUnitId = new Map<string, typeof meters>();
    for (const meter of meters) {
      const list = metersByUnitId.get(meter.unitId) ?? [];
      list.push(meter);
      metersByUnitId.set(meter.unitId, list);
    }

    const additional = input.additionalItems ?? [];
    const generatedInvoiceIds: string[] = [];
    const skipped: BatchGenerateInvoicesResult['skipped'] = [];

    for (const c of contracts) {
      // Skip rule 1: contract not active.
      if (c.status !== 'active') {
        skipped.push({ unitId: c.unitId, contractId: c.id, reason: 'inactive_contract' });
        continue;
      }
      // Skip rule 2: already invoiced.
      if (existingSet.has(c.id)) {
        skipped.push({ unitId: c.unitId, contractId: c.id, reason: 'duplicate_invoice' });
        continue;
      }
      // Skip rule 3: missing reading for an EXISTING meter on this unit.
      const unitMeters = metersByUnitId.get(c.unitId) ?? [];
      const skipReason = this.findMissingReadingReason(unitMeters, readingByMeterId);
      if (skipReason) {
        skipped.push({ unitId: c.unitId, contractId: c.id, reason: skipReason });
        continue;
      }

      // Compose items: rent → water → electric → additional fees.
      const items = this.buildBatchItems({
        period,
        rentAmount: c.rentAmount.toString(),
        unitNumber: c.unit.unitNumber,
        meters: unitMeters,
        readingByMeterId,
        additional,
      });
      const subtotal = toStorage(moneySum(items.map((i) => i.lineTotal)));

      try {
        const created = await prisma.invoice.create({
          data: {
            companyId: ctx.companyId,
            contractId: c.id,
            unitId: c.unitId,
            tenantId: c.tenantId,
            period,
            issueDate: new Date(),
            dueDate,
            subtotal,
            total: subtotal,
            status: 'draft',
            items: {
              create: items.map((it) => ({ companyId: ctx.companyId, ...it })),
            },
          },
          select: { id: true },
        });
        generatedInvoiceIds.push(created.id);
      } catch (err) {
        // Race window: a concurrent batch (or single create) inserted the
        // same (contractId, period) between our pre-check and this insert.
        // Treat as a duplicate skip rather than failing the rest of the batch.
        if (isUniqueConstraintError(err, ['contract_id', 'period'])) {
          skipped.push({ unitId: c.unitId, contractId: c.id, reason: 'duplicate_invoice' });
          continue;
        }
        throw err;
      }
    }

    return { generatedInvoiceIds, skipped };
  }

  // ---------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------

  /**
   * Compute due-date as `dueDayOfMonth` of the period IMMEDIATELY AFTER the
   * billing period, in Bangkok local time. e.g. period `2026-04` + day `5`
   * → `2026-05-05 00:00 Asia/Bangkok` → UTC instant.
   */
  private computeDueDate(period: string, dueDayOfMonth: number): Date {
    const next = addPeriod(period as ReturnType<typeof assertPeriod>, 1);
    const [y, m] = next.split('-').map(Number) as [number, number];
    // Build naive Bangkok-local date, convert to UTC instant for storage.
    const localDue = new Date(y, m - 1, dueDayOfMonth, 0, 0, 0, 0);
    return fromBangkok(localDue);
  }

  /**
   * Determine if a unit has a meter without a reading for the period. We
   * check water first then electric so the response carries the most
   * actionable reason — operators usually fix readings in that order.
   */
  private findMissingReadingReason(
    meters: Array<{ id: string; kind: string }>,
    readingByMeterId: Map<string, unknown>,
  ): BatchSkipReason | null {
    const water = meters.find((m) => m.kind === 'water');
    if (water && !readingByMeterId.has(water.id)) return 'missing_water_reading';
    const electric = meters.find((m) => m.kind === 'electric');
    if (electric && !readingByMeterId.has(electric.id)) return 'missing_electric_reading';
    return null;
  }

  /**
   * Compose the line items for one invoice. Order:
   *   1. Rent (always present — quantity 1)
   *   2. Water (if meter + reading present)
   *   3. Electric (if meter + reading present)
   *   4. Additional flat fees (in caller-supplied order)
   */
  private buildBatchItems(args: {
    period: string;
    rentAmount: string;
    unitNumber: string;
    meters: Array<{
      id: string;
      kind: string;
      ratePerUnit: { toString(): string };
      unitOfMeasure: string;
    }>;
    readingByMeterId: Map<string, { id: string; consumption: { toString(): string } }>;
    additional: BatchAdditionalItem[];
  }): Array<{
    kind: 'rent' | 'water' | 'electric' | 'common_fee' | 'deposit' | 'other';
    description: string;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
    readingId: string | null;
    sortOrder: number;
  }> {
    const items: ReturnType<InvoiceService['buildBatchItems']> = [];
    let sortOrder = 0;

    // Rent — quantity 1, unitPrice = contract.rentAmount snapshot.
    items.push({
      kind: 'rent',
      description: `ค่าเช่าห้อง ${args.unitNumber} (${args.period})`,
      quantity: '1.00',
      unitPrice: args.rentAmount,
      lineTotal: toStorage(args.rentAmount),
      readingId: null,
      sortOrder: sortOrder++,
    });

    // Water + Electric — only if both meter and reading exist.
    for (const kind of ['water', 'electric'] as const) {
      const meter = args.meters.find((m) => m.kind === kind);
      if (!meter) continue;
      const reading = args.readingByMeterId.get(meter.id);
      if (!reading) continue; // Should have been skipped earlier; defensive.

      const quantity = reading.consumption.toString();
      const unitPrice = meter.ratePerUnit.toString();
      items.push({
        kind,
        description:
          kind === 'water'
            ? `ค่าน้ำประปา ${quantity} ${meter.unitOfMeasure} (${args.period})`
            : `ค่าไฟฟ้า ${quantity} ${meter.unitOfMeasure} (${args.period})`,
        quantity,
        unitPrice,
        lineTotal: toStorage(moneyMul(quantity, unitPrice)),
        readingId: reading.id,
        sortOrder: sortOrder++,
      });
    }

    // Additional fees — preserve caller order.
    for (const add of args.additional) {
      items.push({
        kind: add.kind,
        description: add.description,
        quantity: add.quantity,
        unitPrice: add.unitPrice,
        lineTotal: toStorage(moneyMul(add.quantity, add.unitPrice)),
        readingId: null,
        sortOrder: sortOrder++,
      });
    }

    return items;
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
