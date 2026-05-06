import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for AnnouncementService — mocks `@dorm/db` to keep the suite
 * DB-free. Same pattern as contract.service.test.ts.
 *
 * Coverage focus:
 *   - Idempotency pre-check returns existing row (no insert)
 *   - v1 scope guards reject non-'all' audience + scheduled (sendNow=false)
 *   - Recipient resolution filters down to active + lineUserId-bound
 *   - Zero recipients → status='failed' immediately, no enqueue
 *   - With recipients → status='sending' + NotificationService called
 *   - P2002 race → look up + return existing row
 *   - companyId stamped from tenant context on insert
 *   - list / getById basic shape + 404 surface
 *
 * RLS cross-company isolation lives in the e2e suite (real DB).
 */

const mockAnnouncementFindFirst = vi.fn();
const mockAnnouncementFindUnique = vi.fn();
const mockAnnouncementFindMany = vi.fn();
const mockAnnouncementCreate = vi.fn();
const mockTenantFindMany = vi.fn();
const mockCompanyFindFirst = vi.fn();
const mockGetTenantContext = vi.fn();

class MockPrismaClientKnownRequestError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

vi.mock('@dorm/db', () => ({
  prisma: {
    announcement: {
      findFirst: mockAnnouncementFindFirst,
      findUnique: mockAnnouncementFindUnique,
      findMany: mockAnnouncementFindMany,
      create: mockAnnouncementCreate,
    },
    tenant: { findMany: mockTenantFindMany },
    company: { findFirst: mockCompanyFindFirst },
  },
  getTenantContext: mockGetTenantContext,
  Prisma: {
    PrismaClientKnownRequestError: MockPrismaClientKnownRequestError,
  },
}));

const { AnnouncementService } = await import('./announcement.service.js');

const COMPANY_ID = '11111111-1111-1111-8111-111111111111';
const COMPANY_SLUG = 'easyslip-dorm';
const ACTOR_USER_ID = '22222222-2222-2222-8222-222222222222';
const ANNOUNCEMENT_ID = '33333333-3333-3333-8333-333333333333';
const TENANT_ID_A = '44444444-4444-4444-8444-444444444444';
const TENANT_ID_B = '55555555-5555-5555-8555-555555555555';

const VALID_INPUT = {
  title: 'น้ำประปาดับ 13:00-15:00',
  body: 'แจ้งให้ผู้เช่าทุกท่านทราบ น้ำประปาจะดับวันนี้ 13:00-15:00 น.',
  target: { audience: 'all' as const },
  sendNow: true,
};

const IDEMPOTENCY_KEY = `test-key-${'x'.repeat(20)}`;

interface MockNotification {
  enqueueAnnouncementBroadcast: ReturnType<typeof vi.fn>;
}

function makeService(): {
  service: InstanceType<typeof AnnouncementService>;
  notification: MockNotification;
} {
  const notification: MockNotification = {
    enqueueAnnouncementBroadcast: vi.fn().mockResolvedValue(undefined),
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal mock for unit test
  const service = new AnnouncementService(notification as any);
  return { service, notification };
}

describe('AnnouncementService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });
  });

  describe('createBroadcast — idempotency', () => {
    it('returns existing row without recreating when idempotency-key already used', async () => {
      const existingRow = {
        id: ANNOUNCEMENT_ID,
        companyId: COMPANY_ID,
        status: 'sent',
        idempotencyKey: IDEMPOTENCY_KEY,
      };
      mockAnnouncementFindFirst.mockResolvedValueOnce(existingRow);

      const { service, notification } = makeService();
      const result = await service.createBroadcast(VALID_INPUT, IDEMPOTENCY_KEY, ACTOR_USER_ID);

      expect(result).toBe(existingRow);
      expect(mockAnnouncementCreate).not.toHaveBeenCalled();
      expect(notification.enqueueAnnouncementBroadcast).not.toHaveBeenCalled();
    });

    it('returns existing row when P2002 races between pre-check and insert', async () => {
      const winnerRow = { id: ANNOUNCEMENT_ID, status: 'sending' };
      // First findFirst (pre-check) → null (no existing). After P2002, second
      // findFirst returns the row that won the race.
      mockAnnouncementFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(winnerRow);
      mockTenantFindMany.mockResolvedValueOnce([{ id: TENANT_ID_A }]);
      mockCompanyFindFirst.mockResolvedValueOnce({ slug: COMPANY_SLUG });
      mockAnnouncementCreate.mockRejectedValueOnce(
        new MockPrismaClientKnownRequestError('Unique constraint', 'P2002'),
      );

      const { service } = makeService();
      const result = await service.createBroadcast(VALID_INPUT, IDEMPOTENCY_KEY, ACTOR_USER_ID);

      expect(result).toBe(winnerRow);
    });
  });

  describe('createBroadcast — v1 scope guards', () => {
    it('rejects target.audience !== "all"', async () => {
      mockAnnouncementFindFirst.mockResolvedValueOnce(null);
      const { service } = makeService();

      await expect(
        service.createBroadcast(
          {
            ...VALID_INPUT,
            target: { audience: 'property', propertyId: TENANT_ID_A },
          },
          IDEMPOTENCY_KEY,
          ACTOR_USER_ID,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockAnnouncementCreate).not.toHaveBeenCalled();
    });

    it('rejects sendNow=false', async () => {
      mockAnnouncementFindFirst.mockResolvedValueOnce(null);
      const { service } = makeService();

      await expect(
        service.createBroadcast({ ...VALID_INPUT, sendNow: false }, IDEMPOTENCY_KEY, ACTOR_USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockAnnouncementCreate).not.toHaveBeenCalled();
    });
  });

  describe('createBroadcast — recipients + persistence', () => {
    it('creates with status=sending + enqueues broadcast when recipients exist', async () => {
      mockAnnouncementFindFirst.mockResolvedValueOnce(null);
      mockTenantFindMany.mockResolvedValueOnce([{ id: TENANT_ID_A }, { id: TENANT_ID_B }]);
      mockCompanyFindFirst.mockResolvedValueOnce({ slug: COMPANY_SLUG });
      mockAnnouncementCreate.mockResolvedValueOnce({
        id: ANNOUNCEMENT_ID,
        companyId: COMPANY_ID,
        status: 'sending',
      });

      const { service, notification } = makeService();
      const result = await service.createBroadcast(VALID_INPUT, IDEMPOTENCY_KEY, ACTOR_USER_ID);

      expect(result).toMatchObject({ id: ANNOUNCEMENT_ID, status: 'sending' });

      // Verify create payload
      const createArgs = mockAnnouncementCreate.mock.calls[0]?.[0];
      expect(createArgs?.data).toMatchObject({
        companyId: COMPANY_ID,
        title: VALID_INPUT.title,
        body: VALID_INPUT.body,
        target: { audience: 'all' },
        status: 'sending',
        sentAt: null,
        deliveredCount: 0,
        failedCount: 0,
        createdByUserId: ACTOR_USER_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      // Verify broadcast enqueue
      expect(notification.enqueueAnnouncementBroadcast).toHaveBeenCalledWith({
        announcementId: ANNOUNCEMENT_ID,
        companyId: COMPANY_ID,
        companySlug: COMPANY_SLUG,
        title: VALID_INPUT.title,
        body: VALID_INPUT.body,
        tenantIds: [TENANT_ID_A, TENANT_ID_B],
      });
    });

    it('creates with status=failed + sentAt=now + skips enqueue when zero recipients', async () => {
      mockAnnouncementFindFirst.mockResolvedValueOnce(null);
      mockTenantFindMany.mockResolvedValueOnce([]); // no recipients
      mockCompanyFindFirst.mockResolvedValueOnce({ slug: COMPANY_SLUG });
      mockAnnouncementCreate.mockResolvedValueOnce({
        id: ANNOUNCEMENT_ID,
        status: 'failed',
      });

      const { service, notification } = makeService();
      const result = await service.createBroadcast(VALID_INPUT, IDEMPOTENCY_KEY, ACTOR_USER_ID);

      expect(result).toMatchObject({ status: 'failed' });

      const createArgs = mockAnnouncementCreate.mock.calls[0]?.[0];
      expect(createArgs?.data?.status).toBe('failed');
      expect(createArgs?.data?.sentAt).toBeInstanceOf(Date);

      expect(notification.enqueueAnnouncementBroadcast).not.toHaveBeenCalled();
    });

    it('queries tenant.findMany with status=active + lineUserId not null', async () => {
      mockAnnouncementFindFirst.mockResolvedValueOnce(null);
      mockTenantFindMany.mockResolvedValueOnce([]);
      mockCompanyFindFirst.mockResolvedValueOnce({ slug: COMPANY_SLUG });
      mockAnnouncementCreate.mockResolvedValueOnce({ id: ANNOUNCEMENT_ID });

      const { service } = makeService();
      await service.createBroadcast(VALID_INPUT, IDEMPOTENCY_KEY, ACTOR_USER_ID);

      const findManyArgs = mockTenantFindMany.mock.calls[0]?.[0];
      expect(findManyArgs?.where).toEqual({
        status: 'active',
        lineUserId: { not: null },
      });
      expect(findManyArgs?.select).toEqual({ id: true });
    });
  });

  describe('list', () => {
    it('queries with take=limit+1 + orderBy [createdAt desc, id desc]', async () => {
      mockAnnouncementFindMany.mockResolvedValueOnce([]);
      const { service } = makeService();

      await service.list({ limit: 20 });

      const args = mockAnnouncementFindMany.mock.calls[0]?.[0];
      expect(args?.take).toBe(21);
      expect(args?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('AND-combines status + createdByUserId filters', async () => {
      mockAnnouncementFindMany.mockResolvedValueOnce([]);
      const { service } = makeService();

      await service.list({
        limit: 10,
        status: 'sent',
        createdByUserId: ACTOR_USER_ID,
      });

      const args = mockAnnouncementFindMany.mock.calls[0]?.[0];
      expect(args?.where).toMatchObject({
        status: 'sent',
        createdByUserId: ACTOR_USER_ID,
      });
    });
  });

  describe('getById', () => {
    it('throws NotFoundException when no row matches', async () => {
      mockAnnouncementFindUnique.mockResolvedValueOnce(null);
      const { service } = makeService();

      await expect(service.getById(ANNOUNCEMENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the row when found', async () => {
      const row = { id: ANNOUNCEMENT_ID, status: 'sent' };
      mockAnnouncementFindUnique.mockResolvedValueOnce(row);
      const { service } = makeService();

      const result = await service.getById(ANNOUNCEMENT_ID);
      expect(result).toBe(row);
    });
  });
});
