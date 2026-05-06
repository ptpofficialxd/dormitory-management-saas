import { describe, expect, it, vi } from 'vitest';
import type { OverdueInvoiceLike, UnitStatusGroup } from './dashboard.service.js';

// Mock `@dorm/db` so loading dashboard.service.js doesn't try to init a
// real Prisma client (would attempt a DB connection at module-load time).
// The pure helpers under test never touch prisma — the mock is just a stub
// to satisfy the import graph. Same pattern as contract.service.test.ts.
vi.mock('@dorm/db', () => ({
  prisma: {},
  Prisma: {},
}));

const { bucketArrearsByAging, projectOccupancy } = await import('./dashboard.service.js');

/**
 * Unit tests focus on the pure helpers — the SELECT side is exercised by
 * the e2e suite (which seeds 2 companies + asserts cross-tenant isolation
 * via real RLS). Pure helpers are where the business logic lives anyway:
 *   - aging-bucket cutoffs
 *   - empty-input handling
 *   - division-by-zero in occupancy rate
 *   - decimal-safe summation (relies on @dorm/shared/money)
 */

const NOW = new Date('2026-05-06T10:00:00.000Z');

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

function inv(daysOverdue: number, total: string): OverdueInvoiceLike {
  return { dueDate: daysAgo(daysOverdue), total };
}

describe('bucketArrearsByAging', () => {
  it('returns all-zero buckets for empty input', () => {
    const out = bucketArrearsByAging([], NOW);
    expect(out.bucket1to30).toEqual({ count: 0, amount: '0.00' });
    expect(out.bucket31to60).toEqual({ count: 0, amount: '0.00' });
    expect(out.bucket60plus).toEqual({ count: 0, amount: '0.00' });
    expect(out.total).toEqual({ count: 0, amount: '0.00' });
  });

  it('sorts each invoice into the correct bucket by days overdue', () => {
    const out = bucketArrearsByAging(
      [
        inv(1, '1000.00'), //  → bucket1to30
        inv(15, '2500.00'), //  → bucket1to30
        inv(30, '3000.00'), //  → bucket1to30 (boundary inclusive)
        inv(31, '4000.00'), //  → bucket31to60 (boundary inclusive)
        inv(60, '5000.00'), //  → bucket31to60 (boundary inclusive)
        inv(61, '6000.00'), //  → bucket60plus (boundary exclusive)
        inv(180, '7500.00'), // → bucket60plus
      ],
      NOW,
    );

    expect(out.bucket1to30.count).toBe(3);
    expect(out.bucket1to30.amount).toBe('6500.00'); // 1000 + 2500 + 3000

    expect(out.bucket31to60.count).toBe(2);
    expect(out.bucket31to60.amount).toBe('9000.00'); // 4000 + 5000

    expect(out.bucket60plus.count).toBe(2);
    expect(out.bucket60plus.amount).toBe('13500.00'); // 6000 + 7500

    expect(out.total.count).toBe(7);
    expect(out.total.amount).toBe('29000.00'); // 6500 + 9000 + 13500
  });

  it('skips invoices not yet 1 full day overdue (defence in depth)', () => {
    // The Prisma WHERE already filters dueDate < now, but the helper guards
    // against off-by-one drift if a caller forgets that filter.
    const fiveHoursAgo = new Date(NOW.getTime() - 5 * 60 * 60 * 1000);
    const out = bucketArrearsByAging([{ dueDate: fiveHoursAgo, total: '500.00' }], NOW);
    expect(out.total.count).toBe(0);
    expect(out.total.amount).toBe('0.00');
  });

  it('preserves Decimal precision when summing many small amounts', () => {
    // 100 invoices × 0.01 = 1.00 (NOT 0.9999999... — proves Decimal sum).
    const tiny = Array.from({ length: 100 }, () => inv(5, '0.01'));
    const out = bucketArrearsByAging(tiny, NOW);
    expect(out.bucket1to30.count).toBe(100);
    expect(out.bucket1to30.amount).toBe('1.00');
  });
});

describe('projectOccupancy', () => {
  it('returns all-zero with rate=0 (NOT NaN) for empty input', () => {
    const out = projectOccupancy([]);
    expect(out).toEqual({
      totalUnits: 0,
      occupiedUnits: 0,
      vacantUnits: 0,
      maintenanceUnits: 0,
      reservedUnits: 0,
      rate: 0,
    });
  });

  it('fills missing statuses with zero', () => {
    // Company has only occupied + vacant; maintenance + reserved are absent.
    const groups: UnitStatusGroup[] = [
      { status: 'occupied', _count: { _all: 30 } },
      { status: 'vacant', _count: { _all: 10 } },
    ];
    const out = projectOccupancy(groups);
    expect(out.totalUnits).toBe(40);
    expect(out.occupiedUnits).toBe(30);
    expect(out.vacantUnits).toBe(10);
    expect(out.maintenanceUnits).toBe(0);
    expect(out.reservedUnits).toBe(0);
    expect(out.rate).toBeCloseTo(0.75, 5);
  });

  it('computes rate across all four statuses', () => {
    const out = projectOccupancy([
      { status: 'occupied', _count: { _all: 8 } },
      { status: 'vacant', _count: { _all: 1 } },
      { status: 'maintenance', _count: { _all: 1 } },
      { status: 'reserved', _count: { _all: 0 } },
    ]);
    expect(out.totalUnits).toBe(10);
    expect(out.rate).toBeCloseTo(0.8, 5);
  });

  it('rate is exactly 1 when every unit is occupied', () => {
    const out = projectOccupancy([{ status: 'occupied', _count: { _all: 40 } }]);
    expect(out.rate).toBe(1);
  });
});
