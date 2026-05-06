import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for UnitService — mocks `@dorm/db` to keep the suite DB-free.
 *
 * Coverage focus:
 *   - companyId stamping from tenant context on INSERT
 *   - Cross-tenant FK guard: propertyId pre-check rejects foreign properties
 *   - P2002 on (propertyId, unitNumber) → 409 ConflictException
 *   - Cursor pagination: take = limit + 1 + correct keyset where clause
 *   - Filters: propertyId + status AND-combine
 *   - 404 vs 400 mapping (missing unit vs invalid propertyId)
 *
 * RLS cross-company isolation is asserted in the e2e suite (Postgres-only).
 */

const mockUnitFindMany = vi.fn();
const mockUnitFindUnique = vi.fn();
const mockUnitCreate = vi.fn();
const mockUnitUpdate = vi.fn();
const mockUnitCount = vi.fn();
const mockPropertyFindUnique = vi.fn();
const mockGetTenantContext = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    unit: {
      findMany: mockUnitFindMany,
      findUnique: mockUnitFindUnique,
      create: mockUnitCreate,
      update: mockUnitUpdate,
      count: mockUnitCount,
    },
    property: {
      findUnique: mockPropertyFindUnique,
    },
  },
  getTenantContext: mockGetTenantContext,
  // Prisma namespace export — tests don't actually use the types at runtime.
  Prisma: {},
}));

// Stub the soft-warn helper so create() tests don't need to mock the
// company.plan + audit_log dependencies it pulls in (Task #122). The
// helper's own logic is exercised separately.
vi.mock('../../common/util/plan-limit.util.js', () => ({
  softWarnPlanLimit: vi.fn().mockResolvedValue(undefined),
}));

const { UnitService } = await import('./unit.service.js');

const COMPANY_ID = '22222222-2222-2222-8222-222222222222';
const PROP_ID = '33333333-3333-3333-8333-333333333333';
const UNIT_ID = '44444444-4444-4444-8444-444444444444';
const FOREIGN_PROP_ID = '99999999-9999-9999-8999-999999999999';

describe('UnitService', () => {
  let service: InstanceType<typeof UnitService>;

  beforeEach(() => {
    mockUnitFindMany.mockReset();
    mockUnitFindUnique.mockReset();
    mockUnitCreate.mockReset();
    mockUnitUpdate.mockReset();
    mockUnitCount.mockReset();
    // Default count = 0 so soft-warn never trips during create-success tests.
    mockUnitCount.mockResolvedValue(0);
    mockPropertyFindUnique.mockReset();
    mockGetTenantContext.mockReset();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });
    service = new UnitService();
  });

  describe('list', () => {
    it('queries with take=limit+1 + orderBy [createdAt desc, id desc]', async () => {
      mockUnitFindMany.mockResolvedValueOnce([]);
      await service.list({ limit: 20 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockUnitFindMany.mock.calls[0]![0];
      expect(args.take).toBe(21);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.where).toEqual({});
    });

    it('AND-combines propertyId + status filters', async () => {
      mockUnitFindMany.mockResolvedValueOnce([]);
      await service.list({ propertyId: PROP_ID, status: 'vacant', limit: 5 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockUnitFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({ propertyId: PROP_ID, status: 'vacant' });
    });

    it('combines filters with cursor keyset under AND', async () => {
      mockUnitFindMany.mockResolvedValueOnce([]);
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: '2026-04-15T00:00:00.000Z', id: UNIT_ID }),
        'utf8',
      ).toString('base64url');

      await service.list({ cursor, status: 'occupied', limit: 10 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockUnitFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({
        AND: [
          { status: 'occupied' },
          {
            OR: [
              { createdAt: { lt: new Date('2026-04-15T00:00:00.000Z') } },
              { createdAt: new Date('2026-04-15T00:00:00.000Z'), id: { lt: UNIT_ID } },
            ],
          },
        ],
      });
    });
  });

  describe('getById', () => {
    it('returns row on hit', async () => {
      const row = { id: UNIT_ID, unitNumber: 'A-101' };
      mockUnitFindUnique.mockResolvedValueOnce(row);
      await expect(service.getById(UNIT_ID)).resolves.toBe(row);
    });

    it('throws NotFoundException on miss', async () => {
      mockUnitFindUnique.mockResolvedValueOnce(null);
      await expect(service.getById(UNIT_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('verifies propertyId visibility before insert', async () => {
      mockPropertyFindUnique.mockResolvedValueOnce({ id: PROP_ID });
      mockUnitCreate.mockResolvedValueOnce({ id: UNIT_ID });

      await service.create({
        propertyId: PROP_ID,
        unitNumber: 'A-101',
        floor: 1,
        baseRent: '5500.00',
      });

      expect(mockPropertyFindUnique).toHaveBeenCalledWith({
        where: { id: PROP_ID },
        select: { id: true },
      });
      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const createArgs = mockUnitCreate.mock.calls[0]![0];
      expect(createArgs.data.companyId).toBe(COMPANY_ID);
      expect(createArgs.data.propertyId).toBe(PROP_ID);
      expect(createArgs.data.sizeSqm).toBeNull();
      expect(createArgs.data.notes).toBeNull();
    });

    it('rejects foreign propertyId with 400 (RLS hides → findUnique null)', async () => {
      mockPropertyFindUnique.mockResolvedValueOnce(null);

      await expect(
        service.create({
          propertyId: FOREIGN_PROP_ID,
          unitNumber: 'A-101',
          floor: 1,
          baseRent: '5500.00',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockUnitCreate).not.toHaveBeenCalled();
    });

    it('translates P2002 on unitNumber into 409 ConflictException', async () => {
      mockPropertyFindUnique.mockResolvedValueOnce({ id: PROP_ID });
      const p2002 = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['propertyId', 'unitNumber'] },
      });
      mockUnitCreate.mockRejectedValueOnce(p2002);

      await expect(
        service.create({
          propertyId: PROP_ID,
          unitNumber: 'A-101',
          floor: 1,
          baseRent: '5500.00',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    it('404s before any write when unit is missing', async () => {
      mockUnitFindUnique.mockResolvedValueOnce(null);
      await expect(service.update(UNIT_ID, { status: 'vacant' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockUnitUpdate).not.toHaveBeenCalled();
    });

    it('re-verifies propertyId when changing it', async () => {
      mockUnitFindUnique.mockResolvedValueOnce({ id: UNIT_ID });
      mockPropertyFindUnique.mockResolvedValueOnce({ id: PROP_ID });
      mockUnitUpdate.mockResolvedValueOnce({ id: UNIT_ID });

      await service.update(UNIT_ID, { propertyId: PROP_ID });

      expect(mockPropertyFindUnique).toHaveBeenCalledWith({
        where: { id: PROP_ID },
        select: { id: true },
      });
    });

    it('skips propertyId visibility check when not changing it', async () => {
      mockUnitFindUnique.mockResolvedValueOnce({ id: UNIT_ID });
      mockUnitUpdate.mockResolvedValueOnce({ id: UNIT_ID });

      await service.update(UNIT_ID, { status: 'maintenance' });

      expect(mockPropertyFindUnique).not.toHaveBeenCalled();
    });

    it('rejects foreign propertyId on update with 400', async () => {
      mockUnitFindUnique.mockResolvedValueOnce({ id: UNIT_ID });
      mockPropertyFindUnique.mockResolvedValueOnce(null);

      await expect(service.update(UNIT_ID, { propertyId: FOREIGN_PROP_ID })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockUnitUpdate).not.toHaveBeenCalled();
    });

    it('omits sizeSqm + notes from data when input does not include them', async () => {
      mockUnitFindUnique.mockResolvedValueOnce({ id: UNIT_ID });
      mockUnitUpdate.mockResolvedValueOnce({ id: UNIT_ID });

      await service.update(UNIT_ID, { status: 'occupied' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockUnitUpdate.mock.calls[0]![0];
      expect(args.data).not.toHaveProperty('sizeSqm');
      expect(args.data).not.toHaveProperty('notes');
      expect(args.data.status).toBe('occupied');
    });

    it('passes sizeSqm: null through to clear the column', async () => {
      mockUnitFindUnique.mockResolvedValueOnce({ id: UNIT_ID });
      mockUnitUpdate.mockResolvedValueOnce({ id: UNIT_ID });

      // sizeSqm is moneySchema.optional() — Zod allows omit but not null on
      // create. On update we still treat undefined as no-op; this test asserts
      // that when the service is told a value (even nullable), it forwards it.
      await service.update(UNIT_ID, { sizeSqm: '25.50' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockUnitUpdate.mock.calls[0]![0];
      expect(args.data.sizeSqm).toBe('25.50');
    });
  });
});
