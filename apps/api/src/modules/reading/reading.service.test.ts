import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for ReadingService — mocks `@dorm/db` to keep the suite DB-free.
 *
 * Coverage focus:
 *   - companyId stamping from tenant context on INSERT
 *   - Cross-tenant FK guard: meterId pre-check rejects foreign meters
 *   - valuePrevious resolution: defaults "0.00" when no prior reading
 *   - valuePrevious resolution: pulls latest STRICTLY-earlier period
 *   - consumption derivation via decimal.js (no float drift)
 *   - Negative consumption → 400 NegativeConsumption
 *   - P2002 on (meter_id, period) → 409 ReadingAlreadyExists
 *   - Update: recompute consumption against STORED valuePrevious (no re-lookup)
 *   - Update: undefined fields are no-ops
 *   - Update: negative-correction guard
 *   - readByUserId left null in MVP
 *
 * RLS cross-company isolation is asserted in the e2e suite (Postgres-only).
 */

const mockReadingFindMany = vi.fn();
const mockReadingFindUnique = vi.fn();
const mockReadingFindFirst = vi.fn();
const mockReadingCreate = vi.fn();
const mockReadingUpdate = vi.fn();
const mockMeterFindUnique = vi.fn();
const mockGetTenantContext = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    reading: {
      findMany: mockReadingFindMany,
      findUnique: mockReadingFindUnique,
      findFirst: mockReadingFindFirst,
      create: mockReadingCreate,
      update: mockReadingUpdate,
    },
    meter: {
      findUnique: mockMeterFindUnique,
    },
  },
  getTenantContext: mockGetTenantContext,
  // Prisma namespace export — tests don't actually use the types at runtime.
  Prisma: {},
}));

const { ReadingService } = await import('./reading.service.js');

const COMPANY_ID = '22222222-2222-2222-8222-222222222222';
const METER_ID = '55555555-5555-5555-8555-555555555555';
const READING_ID = '66666666-6666-6666-8666-666666666666';
const FOREIGN_METER_ID = '99999999-9999-9999-8999-999999999999';

describe('ReadingService', () => {
  let service: InstanceType<typeof ReadingService>;

  beforeEach(() => {
    mockReadingFindMany.mockReset();
    mockReadingFindUnique.mockReset();
    mockReadingFindFirst.mockReset();
    mockReadingCreate.mockReset();
    mockReadingUpdate.mockReset();
    mockMeterFindUnique.mockReset();
    mockGetTenantContext.mockReset();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });
    service = new ReadingService();
  });

  describe('list', () => {
    it('queries with take=limit+1 + orderBy [createdAt desc, id desc]', async () => {
      mockReadingFindMany.mockResolvedValueOnce([]);
      await service.list({ limit: 20 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockReadingFindMany.mock.calls[0]![0];
      expect(args.take).toBe(21);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.where).toEqual({});
    });

    it('AND-combines meterId + period filters', async () => {
      mockReadingFindMany.mockResolvedValueOnce([]);
      await service.list({ meterId: METER_ID, period: '2026-04', limit: 5 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockReadingFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({ meterId: METER_ID, period: '2026-04' });
    });

    it('combines filters with cursor keyset under AND', async () => {
      mockReadingFindMany.mockResolvedValueOnce([]);
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: '2026-04-15T00:00:00.000Z', id: READING_ID }),
        'utf8',
      ).toString('base64url');

      await service.list({ cursor, period: '2026-04', limit: 10 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockReadingFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({
        AND: [
          { period: '2026-04' },
          {
            OR: [
              { createdAt: { lt: new Date('2026-04-15T00:00:00.000Z') } },
              { createdAt: new Date('2026-04-15T00:00:00.000Z'), id: { lt: READING_ID } },
            ],
          },
        ],
      });
    });
  });

  describe('getById', () => {
    it('returns row on hit', async () => {
      const row = { id: READING_ID, period: '2026-04' };
      mockReadingFindUnique.mockResolvedValueOnce(row);
      await expect(service.getById(READING_ID)).resolves.toBe(row);
    });

    it('throws NotFoundException on miss', async () => {
      mockReadingFindUnique.mockResolvedValueOnce(null);
      await expect(service.getById(READING_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('first reading defaults valuePrevious to "0.00" + computes consumption', async () => {
      mockMeterFindUnique.mockResolvedValueOnce({ id: METER_ID });
      mockReadingFindFirst.mockResolvedValueOnce(null);
      mockReadingCreate.mockResolvedValueOnce({ id: READING_ID });

      await service.create({
        meterId: METER_ID,
        period: '2026-04',
        valueCurrent: '1234.50',
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockReadingCreate.mock.calls[0]![0];
      expect(args.data.companyId).toBe(COMPANY_ID);
      expect(args.data.valuePrevious).toBe('0.00');
      expect(args.data.consumption).toBe('1234.50');
      expect(args.data.photoKey).toBeNull();
      expect(args.data.readByUserId).toBeNull();
      expect(args.data.readAt).toBeInstanceOf(Date);
    });

    it('looks up valuePrevious from STRICTLY-earlier period', async () => {
      mockMeterFindUnique.mockResolvedValueOnce({ id: METER_ID });
      mockReadingFindFirst.mockResolvedValueOnce({
        valueCurrent: { toString: () => '1000.00' },
      });
      mockReadingCreate.mockResolvedValueOnce({ id: READING_ID });

      await service.create({
        meterId: METER_ID,
        period: '2026-04',
        valueCurrent: '1234.56',
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const findFirstArgs = mockReadingFindFirst.mock.calls[0]![0];
      expect(findFirstArgs.where).toEqual({ meterId: METER_ID, period: { lt: '2026-04' } });
      expect(findFirstArgs.orderBy).toEqual({ period: 'desc' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const createArgs = mockReadingCreate.mock.calls[0]![0];
      expect(createArgs.data.valuePrevious).toBe('1000.00');
      expect(createArgs.data.consumption).toBe('234.56');
    });

    it('rejects foreign meterId with 400 (RLS hides → findUnique null)', async () => {
      mockMeterFindUnique.mockResolvedValueOnce(null);

      await expect(
        service.create({
          meterId: FOREIGN_METER_ID,
          period: '2026-04',
          valueCurrent: '100.00',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockReadingFindFirst).not.toHaveBeenCalled();
      expect(mockReadingCreate).not.toHaveBeenCalled();
    });

    it('rejects negative consumption with 400 NegativeConsumption', async () => {
      mockMeterFindUnique.mockResolvedValueOnce({ id: METER_ID });
      mockReadingFindFirst.mockResolvedValueOnce({
        valueCurrent: { toString: () => '1500.00' },
      });

      await expect(
        service.create({
          meterId: METER_ID,
          period: '2026-04',
          valueCurrent: '1400.00',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockReadingCreate).not.toHaveBeenCalled();
    });

    it('translates P2002 on (meter_id, period) into 409 ReadingAlreadyExists', async () => {
      mockMeterFindUnique.mockResolvedValueOnce({ id: METER_ID });
      mockReadingFindFirst.mockResolvedValueOnce(null);
      const p2002 = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['meter_id', 'period'] },
      });
      mockReadingCreate.mockRejectedValueOnce(p2002);

      await expect(
        service.create({
          meterId: METER_ID,
          period: '2026-04',
          valueCurrent: '100.00',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('forwards explicit readAt when provided', async () => {
      mockMeterFindUnique.mockResolvedValueOnce({ id: METER_ID });
      mockReadingFindFirst.mockResolvedValueOnce(null);
      mockReadingCreate.mockResolvedValueOnce({ id: READING_ID });

      await service.create({
        meterId: METER_ID,
        period: '2026-04',
        valueCurrent: '100.00',
        readAt: '2026-04-30T17:00:00.000Z',
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockReadingCreate.mock.calls[0]![0];
      expect(args.data.readAt).toEqual(new Date('2026-04-30T17:00:00.000Z'));
    });

    it('rethrows non-P2002 errors untouched', async () => {
      mockMeterFindUnique.mockResolvedValueOnce({ id: METER_ID });
      mockReadingFindFirst.mockResolvedValueOnce(null);
      mockReadingCreate.mockRejectedValueOnce(new Error('boom'));

      await expect(
        service.create({
          meterId: METER_ID,
          period: '2026-04',
          valueCurrent: '100.00',
        }),
      ).rejects.toThrow('boom');
    });
  });

  describe('update', () => {
    it('404s before any write when reading is missing', async () => {
      mockReadingFindUnique.mockResolvedValueOnce(null);
      await expect(service.update(READING_ID, { photoKey: 'key' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockReadingUpdate).not.toHaveBeenCalled();
    });

    it('recomputes consumption against STORED valuePrevious (no re-lookup)', async () => {
      mockReadingFindUnique.mockResolvedValueOnce({
        id: READING_ID,
        valuePrevious: '1000.00',
        valueCurrent: '1234.50',
        consumption: '234.50',
      });
      mockReadingUpdate.mockResolvedValueOnce({ id: READING_ID });

      await service.update(READING_ID, { valueCurrent: '1300.00' });

      // No re-lookup of prior reading on update.
      expect(mockReadingFindFirst).not.toHaveBeenCalled();

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockReadingUpdate.mock.calls[0]![0];
      expect(args.data.valueCurrent).toBe('1300.00');
      expect(args.data.consumption).toBe('300.00');
    });

    it('rejects negative correction with 400 NegativeConsumption', async () => {
      mockReadingFindUnique.mockResolvedValueOnce({
        id: READING_ID,
        valuePrevious: '1000.00',
        valueCurrent: '1234.50',
        consumption: '234.50',
      });

      await expect(service.update(READING_ID, { valueCurrent: '900.00' })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockReadingUpdate).not.toHaveBeenCalled();
    });

    it('omits untouched fields from update data', async () => {
      mockReadingFindUnique.mockResolvedValueOnce({
        id: READING_ID,
        valuePrevious: '1000.00',
        valueCurrent: '1234.50',
        consumption: '234.50',
      });
      mockReadingUpdate.mockResolvedValueOnce({ id: READING_ID });

      await service.update(READING_ID, { photoKey: 'r2/path/to/image.jpg' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockReadingUpdate.mock.calls[0]![0];
      expect(args.data).not.toHaveProperty('valueCurrent');
      expect(args.data).not.toHaveProperty('consumption');
      expect(args.data).not.toHaveProperty('readAt');
      expect(args.data.photoKey).toBe('r2/path/to/image.jpg');
    });

    it('forwards readAt when provided as ISO string', async () => {
      mockReadingFindUnique.mockResolvedValueOnce({
        id: READING_ID,
        valuePrevious: '1000.00',
        valueCurrent: '1234.50',
        consumption: '234.50',
      });
      mockReadingUpdate.mockResolvedValueOnce({ id: READING_ID });

      await service.update(READING_ID, { readAt: '2026-04-30T18:00:00.000Z' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockReadingUpdate.mock.calls[0]![0];
      expect(args.data.readAt).toEqual(new Date('2026-04-30T18:00:00.000Z'));
    });
  });
});
