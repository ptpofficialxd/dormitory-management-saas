import { prisma } from '@dorm/db';
import { type Period, currentPeriod, periodEndUtc, periodStartUtc } from '@dorm/shared/date';
import { ZERO, sum, toStorage } from '@dorm/shared/money';
import type {
  ArrearsBucket,
  DashboardArrears,
  DashboardOccupancy,
  DashboardPipeline,
  DashboardRevenue,
  DashboardSummary,
} from '@dorm/shared/zod';
import { Injectable } from '@nestjs/common';

/**
 * DashboardService — admin KPIs in one round-trip.
 *
 * Concurrency model:
 *   The 7 SELECTs are issued in `Promise.all` so the wall-clock cost is
 *   `max(query)` not `sum(query)`. They share the request's tenant tx (the
 *   `prisma` proxy from `@dorm/db` routes through the active interactive
 *   transaction stored in ALS — see packages/db/src/tenant-context.ts),
 *   so RLS policies bind once on connection setup and cover every query.
 *   No extra `withTenant` wrap needed here — the TenantContextInterceptor
 *   has already opened the tx by the time this service runs.
 *
 * Money handling:
 *   Prisma `Decimal(10,2)` aggregates come back as `Decimal | null` (null
 *   when the WHERE clause matches zero rows). Convert via the `@dorm/shared/money`
 *   helpers — never `Number(decimal)` — so the wire string keeps Decimal
 *   precision. `toStorage()` clamps to 2dp / HALF_UP rounding (ADR-0005).
 *
 * Arrears v1 simplification:
 *   `bucket.amount` sums `invoice.total` (the FACE total) for every overdue
 *   invoice. Partially-paid invoices over-report by the confirmed payment
 *   amount; documented in `arrearsBucketSchema`. The accurate version
 *   subtracts confirmed payments per invoice but doubles the query weight
 *   — defer until beta customer flags it.
 *
 * Occupancy:
 *   Counted by `unit.status` directly; we do NOT recompute "is this unit
 *   actually occupied per active contract" because the unit/contract
 *   lifecycle services keep `unit.status` in sync. If they ever drift, the
 *   fix belongs there, not here.
 */
@Injectable()
export class DashboardService {
  async getSummary(): Promise<DashboardSummary> {
    const now = new Date();
    const period = currentPeriod(now);
    const monthStart = periodStartUtc(period);
    const monthEnd = periodEndUtc(period); // exclusive

    const [
      confirmedAgg,
      pendingAgg,
      overdueInvoices,
      unitGroups,
      activeContractsCount,
      openMaintenanceCount,
      pendingPaymentCount,
    ] = await Promise.all([
      // Revenue confirmed in current Bangkok-local month.
      // `paidAt` is set when the tenant claims they paid; `confirmedAt` is
      // when admin OK'd the slip. We match on `paidAt` so cashflow tracks
      // when the money actually moved, not when it was confirmed.
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: {
          status: 'confirmed',
          paidAt: { gte: monthStart, lt: monthEnd },
        },
      }),
      // Pending payments — slips waiting for admin to confirm. No date
      // filter: surface the entire backlog in money terms.
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { status: 'pending' },
      }),
      // Overdue invoices (status check + date guard belt-and-braces — the
      // status enum has `overdue` but the cron that flips it might lag, so
      // we ALSO accept `issued` / `partially_paid` past due-date).
      prisma.invoice.findMany({
        where: {
          status: { in: ['issued', 'partially_paid', 'overdue'] },
          dueDate: { lt: now },
        },
        select: { id: true, dueDate: true, total: true },
      }),
      // Unit counts grouped by status. groupBy returns one row per status
      // value present in the company; missing statuses default to 0.
      prisma.unit.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.contract.count({ where: { status: 'active' } }),
      prisma.maintenanceRequest.count({
        where: { status: { in: ['open', 'in_progress'] } },
      }),
      prisma.payment.count({ where: { status: 'pending' } }),
    ]);

    const revenue: DashboardRevenue = {
      confirmed: toStorage(confirmedAgg._sum.amount ?? ZERO),
      pendingConfirm: toStorage(pendingAgg._sum.amount ?? ZERO),
    };

    const arrears = bucketArrearsByAging(
      overdueInvoices.map((inv) => ({
        dueDate: inv.dueDate,
        total: inv.total.toString(),
      })),
      now,
    );

    const occupancy = projectOccupancy(unitGroups);

    const pipeline: DashboardPipeline = {
      activeContracts: activeContractsCount,
      openMaintenance: openMaintenanceCount,
      pendingPayments: pendingPaymentCount,
    };

    return {
      asOf: now,
      period,
      revenue,
      arrears,
      occupancy,
      pipeline,
    };
  }
}

// -----------------------------------------------------------------------
// Pure helpers — exported for unit tests, no Prisma dependency.
// -----------------------------------------------------------------------

/** Input shape used by `bucketArrearsByAging` — keeps the helper Prisma-free. */
export type OverdueInvoiceLike = {
  /** UTC instant — invoice's due date. */
  readonly dueDate: Date;
  /** Decimal money as string — `invoice.total`. */
  readonly total: string;
};

/**
 * Bucket overdue invoices into 1-30 / 31-60 / 60+ aging windows.
 *
 * Day delta is computed in UTC instants — both `now` and `dueDate` are
 * UTC, so the difference is timezone-agnostic. Floor to whole days; an
 * invoice due 26 hours ago counts as 1 day overdue (not 0, not 2).
 *
 * Boundary semantics:
 *   - bucket1to30:  1 ≤ days ≤ 30
 *   - bucket31to60: 31 ≤ days ≤ 60
 *   - bucket60plus: days > 60
 *
 * Edge cases:
 *   - days < 1 (i.e. due today / future) → not counted in any bucket. The
 *     caller's WHERE clause already filters `dueDate < now`, but we guard
 *     against off-by-one drift across DST-free TZ math anyway.
 *   - empty input → all buckets are zero.
 */
export function bucketArrearsByAging(
  invoices: ReadonlyArray<OverdueInvoiceLike>,
  now: Date,
): DashboardArrears {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const acc = {
    bucket1to30: { ids: 0, amounts: [] as string[] },
    bucket31to60: { ids: 0, amounts: [] as string[] },
    bucket60plus: { ids: 0, amounts: [] as string[] },
  };

  for (const inv of invoices) {
    const days = Math.floor((now.getTime() - inv.dueDate.getTime()) / DAY_MS);
    if (days < 1) continue;
    if (days <= 30) {
      acc.bucket1to30.ids += 1;
      acc.bucket1to30.amounts.push(inv.total);
    } else if (days <= 60) {
      acc.bucket31to60.ids += 1;
      acc.bucket31to60.amounts.push(inv.total);
    } else {
      acc.bucket60plus.ids += 1;
      acc.bucket60plus.amounts.push(inv.total);
    }
  }

  const bucket = (b: { ids: number; amounts: string[] }): ArrearsBucket => ({
    count: b.ids,
    amount: toStorage(sum(b.amounts)),
  });

  const total: ArrearsBucket = {
    count: acc.bucket1to30.ids + acc.bucket31to60.ids + acc.bucket60plus.ids,
    amount: toStorage(
      sum([...acc.bucket1to30.amounts, ...acc.bucket31to60.amounts, ...acc.bucket60plus.amounts]),
    ),
  };

  return {
    bucket1to30: bucket(acc.bucket1to30),
    bucket31to60: bucket(acc.bucket31to60),
    bucket60plus: bucket(acc.bucket60plus),
    total,
  };
}

/** Input shape used by `projectOccupancy` — mirrors Prisma's groupBy result. */
export type UnitStatusGroup = {
  readonly status: 'vacant' | 'occupied' | 'maintenance' | 'reserved';
  readonly _count: { readonly _all: number };
};

/**
 * Project Prisma's groupBy rows into the dashboard occupancy shape, filling
 * missing statuses with zero. `rate` is `occupied / total` clamped to
 * `[0, 1]`; returns `0` (not NaN) for empty companies.
 */
export function projectOccupancy(groups: ReadonlyArray<UnitStatusGroup>): DashboardOccupancy {
  const counts = { vacant: 0, occupied: 0, maintenance: 0, reserved: 0 };
  for (const g of groups) {
    counts[g.status] = g._count._all;
  }
  const totalUnits = counts.vacant + counts.occupied + counts.maintenance + counts.reserved;
  const rate = totalUnits === 0 ? 0 : counts.occupied / totalUnits;
  return {
    totalUnits,
    occupiedUnits: counts.occupied,
    vacantUnits: counts.vacant,
    maintenanceUnits: counts.maintenance,
    reservedUnits: counts.reserved,
    rate,
  };
}

/** Re-export for tests + future report endpoints that need the same period helper. */
export type { Period };
