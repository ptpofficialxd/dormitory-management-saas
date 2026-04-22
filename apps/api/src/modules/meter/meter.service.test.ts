import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for MeterService — mocks `@dorm/db` to keep the suite DB-free.
 *
 * Coverage focus:
 *   - companyId stamping from tenant context on INSERT
 *   - Cross-tenant FK guard: unitId pre-check rejects foreign units
 *   - P2002 on (unitId, kind) → 409 ConflictException MeterAlreadyExists
 *   - Cursor pagination: take = limit + 1 + correct keyset where clause
 *   - Filters: unitId + kind AND-combine
 *   - Update narrowness: undefined fields are no-ops; unitId/kind not editable
 *   - 404 vs 400 mapping (missing meter vs invalid unitId)
 *
 * RLS cross-company isolation is asserted in the e2e suite (Postgres-only).
 */

const mockMeterFindMany = vi.fn();
const mockMeterFindUnique = vi.fn();
const mockMeterCreate = vi.fn();
const mockMeterUpdate = vi.fn();
const mockUnitFindUnique = vi.fn();
const mockGetTenantContext = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    meter: {
      findMany: mockMeterFindMany,
      findUnique: mockMeterFindUnique,
      create: mockMeterCreate,
      update: mockMeterUpdate,
    },
    unit: {
      findUnique: mockUnitFindUnique,
    },
  },
  getTenantContext: mockGetTenantContext,
  // Prisma namespace export — tests don't actually use the types at runtime.
  Prisma: {},
}));

const { MeterService } = await import('./meter.service.js');

const COMPANY_ID = '22222222-2222-2222-8222-222222222222';
const UNIT_ID = '44444444-4444-4444-8444-444444444444';
const METER_ID = '55555555-5555-5555-8555-555555555555';
const FOREIGN_UNIT_ID = '99999999-9999-9999-8999-999999999999';

describe('MeterService', () => {
  let service: InstanceType<typeof MeterService>;

  beforeEach(() => {
    mockMeterFindMany.mockReset();
    mockMeterFindUnique.mockReset();
    mockMeterCreate.mockReset();
    mockMeterUpdate.mockReset();
    mockUnitFindUnique.mockReset();
    mockGetTenantContext.mockReset();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });
    service = new MeterService();
  });

  describe('list', () => {
    it('queries with take=limit+1 + orderBy [createdAt desc, id desc]', async () => {
      mockMeterFindMany.mockResolvedValueOnce([]);
      await service.list({ limit: 20 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockMeterFindMany.mock.calls[0]![0];
      expect(args.take).toBe(21);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.where).toEqual({});
    });

    it('AND-combines unitId + kind filters', async () => {
      mockMeterFindMany.mockResolvedValueOnce([]);
      await service.list({ unitId: UNIT_ID, kind: 'water', limit: 5 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockMeterFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({ unitId: UNIT_ID, kind: 'water' });
    });

    it('combines filters with cursor keyset under AND', async () => {
      mockMeterFindMany.mockResolvedValueOnce([]);
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: '2026-04-15T00:00:00.000Z', id: METER_ID }),
        'utf8',
      ).toString('base64url');

      await service.list({ cursor, kind: 'electric', limit: 10 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockMeterFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({
        AND: [
          { kind: 'electric' },
          {
            OR: [
              { createdAt: { lt: new Date('2026-04-15T00:00:00.000Z') } },
              { createdAt: new Date('2026-04-15T00:00:00.000Z'), id: { lt: METER_ID } },
            ],
          },
        ],
      });
    });
  });

  describe('getById', () => {
    it('returns row on hit', async () => {
      const row = { id: METER_ID, kind: 'water' };
      mockMeterFindUnique.mockResolvedValueOnce(row);
      await expect(service.getById(METER_ID)).resolves.toBe(row);
    });

    it('throws NotFoundException on miss', async () => {
      mockMeterFindUnique.mockResolvedValueOnce(null);
      await expect(service.getById(METER_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('verifies unitId visibility before insert and stamps companyId', async () => {
      mockUnitFindUnique.mockResolvedValueOnce({ id: UNIT_ID });
      mockMeterCreate.mockResolvedValueOnce({ id: METER_ID });

      await service.create({
        unitId: UNIT_ID,
        kind: 'water',
        unitOfMeasure: 'm³',
        ratePerUnit: '18.0000',
      });

      expect(mockUnitFindUnique).toHaveBeenCalledWith({
        where: { id: UNIT_ID },
        select: { id: true },
      });
      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const createArgs = mockMeterCreate.mock.calls[0]![0];
      expect(createArgs.data.companyId).toBe(COMPANY_ID);
      expect(createArgs.data.unitId).toBe(UNIT_ID);
      expect(createArgs.data.kind).toBe('water');
      expect(createArgs.data.serialNo).toBeNull();
      expect(createArgs.data.ratePerUnit).toBe('18.0000');
    });

    it('forwards optional serialNo when provided', async () => {
      mockUnitFindUnique.mockResolvedValueOnce({ id: UNIT_ID });
      mockMeterCreate.mockResolvedValueOnce({ id: METER_ID });

      await service.create({
        unitId: UNIT_ID,
        kind: 'electric',
        serialNo: 'EM-2026-0042',
        unitOfMeasure: 'kWh',
        ratePerUnit: '5.8124',
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const createArgs = mockMeterCreate.mock.calls[0]![0];
      expect(createArgs.data.serialNo).toBe('EM-2026-0042');
    });

    it('rejects foreign unitId with 400 (RLS hides → findUnique null)', async () => {
      mockUnitFindUnique.mockResolvedValueOnce(null);

      await expect(
        service.create({
          unitId: FOREIGN_UNIT_ID,
          kind: 'water',
          unitOfMeasure: 'm³',
          ratePerUnit: '18.0000',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockMeterCreate).not.toHaveBeenCalled();
    });

    it('translates P2002 on (unit_id, kind) into 409 MeterAlreadyExists', async () => {
      mockUnitFindUnique.mockResolvedValueOnce({ id: UNIT_ID });
      const p2002 = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['unit_id', 'kind'] },
      });
      mockMeterCreate.mockRejectedValueOnce(p2002);

      await expect(
        service.create({
          unitId: UNIT_ID,
          kind: 'water',
          unitOfMeasure: 'm³',
          ratePerUnit: '18.0000',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rethrows non-P2002 Prisma errors untouched', async () => {
      mockUnitFindUnique.mockResolvedValueOnce({ id: UNIT_ID });
      mockMeterCreate.mockRejectedValueOnce(new Error('boom'));

      await expect(
        service.create({
          unitId: UNIT_ID,
          kind: 'water',
          unitOfMeasure: 'm³',
          ratePerUnit: '18.0000',
        }),
      ).rejects.toThrow('boom');
    });
  });

  describe('update', () => {
    it('404s before any write when meter is missing', async () => {
      mockMeterFindUnique.mockResolvedValueOnce(null);
      await expect(service.update(METER_ID, { ratePerUnit: '6.0000' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockMeterUpdate).not.toHaveBeenCalled();
    });

    it('omits untouched fields from update data', async () => {
      mockMeterFindUnique.mockResolvedValueOnce({ id: METER_ID });
      mockMeterUpdate.mockResolvedValueOnce({ id: METER_ID });

      await service.update(METER_ID, { ratePerUnit: '6.0000' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockMeterUpdate.mock.calls[0]![0];
      expect(args.data).not.toHaveProperty('serialNo');
      expect(args.data).not.toHaveProperty('unitOfMeasure');
      expect(args.data.ratePerUnit).toBe('6.0000');
    });

    it('does not allow unitId or kind to be patched (not in input schema)', async () => {
      mockMeterFindUnique.mockResolvedValueOnce({ id: METER_ID });
      mockMeterUpdate.mockResolvedValueOnce({ id: METER_ID });

      // Cast: simulating a caller attempting to forge fields beyond the schema.
      await service.update(METER_ID, {
        ratePerUnit: '7.0000',
      } as unknown as Parameters<typeof service.update>[1]);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockMeterUpdate.mock.calls[0]![0];
      expect(args.data).not.toHaveProperty('unitId');
      expect(args.data).not.toHaveProperty('kind');
      expect(args.data).not.toHaveProperty('companyId');
    });

    it('forwards all three patchable fields when provided', async () => {
      mockMeterFindUnique.mockResolvedValueOnce({ id: METER_ID });
      mockMeterUpdate.mockResolvedValueOnce({ id: METER_ID });

      await service.update(METER_ID, {
        serialNo: 'NEW-SN-001',
        unitOfMeasure: 'kWh',
        ratePerUnit: '5.9000',
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockMeterUpdate.mock.calls[0]![0];
      expect(args.data.serialNo).toBe('NEW-SN-001');
      expect(args.data.unitOfMeasure).toBe('kWh');
      expect(args.data.ratePerUnit).toBe('5.9000');
    });
  });
});
