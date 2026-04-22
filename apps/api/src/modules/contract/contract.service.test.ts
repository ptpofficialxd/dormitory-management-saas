import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for ContractService — mocks `@dorm/db` to keep the suite DB-free.
 *
 * Coverage focus:
 *   - companyId stamping from tenant context on INSERT
 *   - Cross-tenant FK guards: unitId + tenantId pre-checks reject foreign rows
 *   - Overlap detection on CREATE (4 scenarios: open-ended, closed, both)
 *   - Overlap re-check on PATCH only when final state is active-like
 *   - 404 on missing contract
 *   - Status / endDate / notes pass-through, immutable fields stay snapshot
 *
 * RLS cross-company isolation is asserted in the e2e suite.
 */

const mockContractFindMany = vi.fn();
const mockContractFindUnique = vi.fn();
const mockContractFindFirst = vi.fn();
const mockContractCreate = vi.fn();
const mockContractUpdate = vi.fn();
const mockUnitFindUnique = vi.fn();
const mockTenantFindUnique = vi.fn();
const mockGetTenantContext = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    contract: {
      findMany: mockContractFindMany,
      findUnique: mockContractFindUnique,
      findFirst: mockContractFindFirst,
      create: mockContractCreate,
      update: mockContractUpdate,
    },
    unit: { findUnique: mockUnitFindUnique },
    tenant: { findUnique: mockTenantFindUnique },
  },
  getTenantContext: mockGetTenantContext,
  Prisma: {},
}));

const { ContractService } = await import('./contract.service.js');

const COMPANY_ID = '22222222-2222-2222-8222-222222222222';
const UNIT_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_ID = '55555555-5555-5555-8555-555555555555';
const CONTRACT_ID = '66666666-6666-6666-8666-666666666666';

describe('ContractService', () => {
  let service: InstanceType<typeof ContractService>;

  beforeEach(() => {
    mockContractFindMany.mockReset();
    mockContractFindUnique.mockReset();
    mockContractFindFirst.mockReset();
    mockContractCreate.mockReset();
    mockContractUpdate.mockReset();
    mockUnitFindUnique.mockReset();
    mockTenantFindUnique.mockReset();
    mockGetTenantContext.mockReset();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });
    service = new ContractService();
  });

  describe('list', () => {
    it('queries with take=limit+1 + orderBy [createdAt desc, id desc]', async () => {
      mockContractFindMany.mockResolvedValueOnce([]);
      await service.list({ limit: 20 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockContractFindMany.mock.calls[0]![0];
      expect(args.take).toBe(21);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.where).toEqual({});
    });

    it('AND-combines unitId + tenantId + status filters', async () => {
      mockContractFindMany.mockResolvedValueOnce([]);
      await service.list({ unitId: UNIT_ID, tenantId: TENANT_ID, status: 'active', limit: 5 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockContractFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({
        unitId: UNIT_ID,
        tenantId: TENANT_ID,
        status: 'active',
      });
    });
  });

  describe('getById', () => {
    it('returns row on hit', async () => {
      const row = { id: CONTRACT_ID, status: 'active' };
      mockContractFindUnique.mockResolvedValueOnce(row);
      await expect(service.getById(CONTRACT_ID)).resolves.toBe(row);
    });

    it('throws NotFoundException on miss', async () => {
      mockContractFindUnique.mockResolvedValueOnce(null);
      await expect(service.getById(CONTRACT_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('verifies unitId + tenantId visibility, runs overlap check, then inserts', async () => {
      mockUnitFindUnique.mockResolvedValueOnce({ id: UNIT_ID });
      mockTenantFindUnique.mockResolvedValueOnce({ id: TENANT_ID });
      mockContractFindFirst.mockResolvedValueOnce(null);
      mockContractCreate.mockResolvedValueOnce({ id: CONTRACT_ID });

      await service.create({
        unitId: UNIT_ID,
        tenantId: TENANT_ID,
        startDate: '2026-04-01',
        endDate: '2026-12-31',
        rentAmount: '5500.00',
        depositAmount: '11000.00',
      });

      expect(mockUnitFindUnique).toHaveBeenCalledWith({
        where: { id: UNIT_ID },
        select: { id: true },
      });
      expect(mockTenantFindUnique).toHaveBeenCalledWith({
        where: { id: TENANT_ID },
        select: { id: true },
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const createArgs = mockContractCreate.mock.calls[0]![0];
      expect(createArgs.data.companyId).toBe(COMPANY_ID);
      expect(createArgs.data.startDate).toEqual(new Date('2026-04-01'));
      expect(createArgs.data.endDate).toEqual(new Date('2026-12-31'));
      expect(createArgs.data.status).toBe('draft');
      expect(createArgs.data.notes).toBeNull();
    });

    it('rejects foreign unitId with 400', async () => {
      mockUnitFindUnique.mockResolvedValueOnce(null);
      mockTenantFindUnique.mockResolvedValueOnce({ id: TENANT_ID });

      await expect(
        service.create({
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          startDate: '2026-04-01',
          rentAmount: '5500.00',
          depositAmount: '11000.00',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockContractCreate).not.toHaveBeenCalled();
    });

    it('rejects foreign tenantId with 400', async () => {
      mockUnitFindUnique.mockResolvedValueOnce({ id: UNIT_ID });
      mockTenantFindUnique.mockResolvedValueOnce(null);

      await expect(
        service.create({
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          startDate: '2026-04-01',
          rentAmount: '5500.00',
          depositAmount: '11000.00',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockContractCreate).not.toHaveBeenCalled();
    });

    it('rejects overlapping draft/active contract with 409', async () => {
      mockUnitFindUnique.mockResolvedValueOnce({ id: UNIT_ID });
      mockTenantFindUnique.mockResolvedValueOnce({ id: TENANT_ID });
      mockContractFindFirst.mockResolvedValueOnce({ id: 'overlapping-contract' });

      await expect(
        service.create({
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          startDate: '2026-04-01',
          endDate: '2026-12-31',
          rentAmount: '5500.00',
          depositAmount: '11000.00',
        }),
      ).rejects.toThrow(ConflictException);

      expect(mockContractCreate).not.toHaveBeenCalled();
    });

    it('overlap query filters draft+active and uses inclusive lte/gte', async () => {
      mockUnitFindUnique.mockResolvedValueOnce({ id: UNIT_ID });
      mockTenantFindUnique.mockResolvedValueOnce({ id: TENANT_ID });
      mockContractFindFirst.mockResolvedValueOnce(null);
      mockContractCreate.mockResolvedValueOnce({ id: CONTRACT_ID });

      await service.create({
        unitId: UNIT_ID,
        tenantId: TENANT_ID,
        startDate: '2026-04-01',
        endDate: '2026-06-30',
        rentAmount: '5500.00',
        depositAmount: '11000.00',
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const overlapArgs = mockContractFindFirst.mock.calls[0]![0];
      expect(overlapArgs.where.unitId).toBe(UNIT_ID);
      expect(overlapArgs.where.status).toEqual({ in: ['draft', 'active'] });
      expect(overlapArgs.where.AND).toEqual([
        { startDate: { lte: new Date('2026-06-30') } },
        { OR: [{ endDate: null }, { endDate: { gte: new Date('2026-04-01') } }] },
      ]);
    });

    it('open-ended new contract drops the upper-bound condition', async () => {
      mockUnitFindUnique.mockResolvedValueOnce({ id: UNIT_ID });
      mockTenantFindUnique.mockResolvedValueOnce({ id: TENANT_ID });
      mockContractFindFirst.mockResolvedValueOnce(null);
      mockContractCreate.mockResolvedValueOnce({ id: CONTRACT_ID });

      await service.create({
        unitId: UNIT_ID,
        tenantId: TENANT_ID,
        startDate: '2026-04-01',
        rentAmount: '5500.00',
        depositAmount: '11000.00',
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const overlapArgs = mockContractFindFirst.mock.calls[0]![0];
      // First AND clause is `{}` because newEnd = +infinity → unbounded above
      expect(overlapArgs.where.AND[0]).toEqual({});
    });
  });

  describe('update', () => {
    it('404s before any write when contract is missing', async () => {
      mockContractFindUnique.mockResolvedValueOnce(null);
      await expect(service.update(CONTRACT_ID, { status: 'active' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockContractUpdate).not.toHaveBeenCalled();
    });

    it('skips overlap check when transitioning active → ended (closing the window)', async () => {
      mockContractFindUnique.mockResolvedValueOnce({
        id: CONTRACT_ID,
        unitId: UNIT_ID,
        startDate: new Date('2026-04-01'),
        endDate: new Date('2026-12-31'),
        status: 'active',
      });
      mockContractUpdate.mockResolvedValueOnce({ id: CONTRACT_ID });

      await service.update(CONTRACT_ID, { status: 'ended' });

      expect(mockContractFindFirst).not.toHaveBeenCalled();
    });

    it('runs overlap re-check when endDate changes on an active contract', async () => {
      mockContractFindUnique.mockResolvedValueOnce({
        id: CONTRACT_ID,
        unitId: UNIT_ID,
        startDate: new Date('2026-04-01'),
        endDate: new Date('2026-12-31'),
        status: 'active',
      });
      mockContractFindFirst.mockResolvedValueOnce(null);
      mockContractUpdate.mockResolvedValueOnce({ id: CONTRACT_ID });

      await service.update(CONTRACT_ID, { endDate: '2027-03-31' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const overlapArgs = mockContractFindFirst.mock.calls[0]![0];
      expect(overlapArgs.where.id).toEqual({ not: CONTRACT_ID });
      expect(overlapArgs.where.AND[0]).toEqual({ startDate: { lte: new Date('2027-03-31') } });
    });

    it('runs overlap re-check when transitioning ended → active (re-opening)', async () => {
      mockContractFindUnique.mockResolvedValueOnce({
        id: CONTRACT_ID,
        unitId: UNIT_ID,
        startDate: new Date('2026-04-01'),
        endDate: new Date('2026-12-31'),
        status: 'ended',
      });
      mockContractFindFirst.mockResolvedValueOnce(null);
      mockContractUpdate.mockResolvedValueOnce({ id: CONTRACT_ID });

      await service.update(CONTRACT_ID, { status: 'active' });

      expect(mockContractFindFirst).toHaveBeenCalledTimes(1);
    });

    it('rejects overlap on update with 409', async () => {
      mockContractFindUnique.mockResolvedValueOnce({
        id: CONTRACT_ID,
        unitId: UNIT_ID,
        startDate: new Date('2026-04-01'),
        endDate: new Date('2026-12-31'),
        status: 'active',
      });
      mockContractFindFirst.mockResolvedValueOnce({ id: 'other-contract' });

      await expect(service.update(CONTRACT_ID, { endDate: '2027-12-31' })).rejects.toThrow(
        ConflictException,
      );
      expect(mockContractUpdate).not.toHaveBeenCalled();
    });

    it('omits endDate + notes from data when input does not include them', async () => {
      mockContractFindUnique.mockResolvedValueOnce({
        id: CONTRACT_ID,
        unitId: UNIT_ID,
        startDate: new Date('2026-04-01'),
        endDate: new Date('2026-12-31'),
        status: 'active',
      });
      mockContractUpdate.mockResolvedValueOnce({ id: CONTRACT_ID });

      await service.update(CONTRACT_ID, { status: 'terminated' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockContractUpdate.mock.calls[0]![0];
      expect(args.data).not.toHaveProperty('endDate');
      expect(args.data).not.toHaveProperty('notes');
      expect(args.data.status).toBe('terminated');
    });
  });
});
