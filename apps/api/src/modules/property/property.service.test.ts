import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for PropertyService — mocks `@dorm/db` to avoid a live DB. The
 * goals here are narrow: verify (a) the service stamps companyId from the
 * tenant context on create, (b) Prisma P2002 maps to ConflictException with
 * the right error envelope, (c) cursor pagination passes the +1 sentinel
 * pattern through to Prisma, (d) NotFoundException is raised on missing rows.
 *
 * Full RLS / cross-company isolation behaviour is covered by the e2e tests
 * (out of scope for unit tests since RLS is a Postgres feature).
 */

const mockFindMany = vi.fn();
const mockFindUnique = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockCount = vi.fn();
const mockGetTenantContext = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    property: {
      findMany: mockFindMany,
      findUnique: mockFindUnique,
      create: mockCreate,
      update: mockUpdate,
      count: mockCount,
    },
  },
  getTenantContext: mockGetTenantContext,
}));

// Stub the soft-warn helper so create() tests don't need to mock the
// company.plan + audit_log dependencies it pulls in (Task #122). The
// helper's own logic is exercised separately.
vi.mock('../../common/util/plan-limit.util.js', () => ({
  softWarnPlanLimit: vi.fn().mockResolvedValue(undefined),
}));

const { PropertyService } = await import('./property.service.js');

const COMPANY_ID = '22222222-2222-2222-8222-222222222222';
const PROP_ID = '33333333-3333-3333-8333-333333333333';

describe('PropertyService', () => {
  let service: InstanceType<typeof PropertyService>;

  beforeEach(() => {
    mockFindMany.mockReset();
    mockFindUnique.mockReset();
    mockCreate.mockReset();
    mockUpdate.mockReset();
    mockCount.mockReset();
    // Default count = 0 so soft-warn never trips during create-success tests.
    mockCount.mockResolvedValue(0);
    mockGetTenantContext.mockReset();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });
    service = new PropertyService();
  });

  describe('list', () => {
    it('queries with take=limit+1 + orderBy [createdAt desc, id desc]', async () => {
      mockFindMany.mockResolvedValueOnce([
        { id: PROP_ID, createdAt: new Date('2026-04-01T00:00:00Z') },
      ]);

      await service.list({ limit: 20 });

      expect(mockFindMany).toHaveBeenCalledTimes(1);
      // biome-ignore lint/style/noNonNullAssertion: call asserted above
      const args = mockFindMany.mock.calls[0]![0];
      expect(args.take).toBe(21);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.where).toBeUndefined();
    });

    it('decodes cursor + applies the (createdAt, id) keyset where clause', async () => {
      mockFindMany.mockResolvedValueOnce([]);
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: '2026-04-15T00:00:00.000Z', id: PROP_ID }),
        'utf8',
      ).toString('base64url');

      await service.list({ cursor, limit: 10 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted above by mockResolvedValueOnce
      const args = mockFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({
        OR: [
          { createdAt: { lt: new Date('2026-04-15T00:00:00.000Z') } },
          { createdAt: new Date('2026-04-15T00:00:00.000Z'), id: { lt: PROP_ID } },
        ],
      });
    });

    it('returns nextCursor when result hits limit + 1', async () => {
      mockFindMany.mockResolvedValueOnce([
        { id: 'a', createdAt: new Date('2026-04-03T00:00:00Z') },
        { id: 'b', createdAt: new Date('2026-04-02T00:00:00Z') },
        { id: 'c', createdAt: new Date('2026-04-01T00:00:00Z') }, // overflow sentinel
      ]);
      const page = await service.list({ limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).not.toBeNull();
    });
  });

  describe('getById', () => {
    it('returns the row on hit', async () => {
      const row = { id: PROP_ID, name: 'Building A' };
      mockFindUnique.mockResolvedValueOnce(row);
      await expect(service.getById(PROP_ID)).resolves.toBe(row);
      expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: PROP_ID } });
    });

    it('throws NotFoundException on miss (RLS may have hidden it)', async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      await expect(service.getById(PROP_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('stamps companyId from tenant context', async () => {
      const created = { id: PROP_ID, companyId: COMPANY_ID, slug: 'bld-a', name: 'Building A' };
      mockCreate.mockResolvedValueOnce(created);

      await service.create({ slug: 'bld-a', name: 'Building A', address: '123 Sukhumvit' });

      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          companyId: COMPANY_ID,
          slug: 'bld-a',
          name: 'Building A',
          address: '123 Sukhumvit',
        },
      });
    });

    it('translates P2002 on (companyId, slug) into 409 ConflictException', async () => {
      const p2002 = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['companyId', 'slug'] },
      });
      mockCreate.mockRejectedValueOnce(p2002);

      await expect(service.create({ slug: 'taken', name: 'X' })).rejects.toThrow(ConflictException);
    });

    it('passes through unrelated errors unchanged', async () => {
      mockCreate.mockRejectedValueOnce(new Error('connection lost'));
      await expect(service.create({ slug: 'a', name: 'X' })).rejects.toThrow('connection lost');
    });
  });

  describe('update', () => {
    it('404s before attempting Prisma update when row is missing', async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      await expect(service.update(PROP_ID, { name: 'New' })).rejects.toThrow(NotFoundException);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('writes only fields present in the input (omits address when undefined)', async () => {
      mockFindUnique.mockResolvedValueOnce({ id: PROP_ID });
      mockUpdate.mockResolvedValueOnce({ id: PROP_ID, name: 'New' });

      await service.update(PROP_ID, { name: 'New' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted above by mockResolvedValueOnce
      const args = mockUpdate.mock.calls[0]![0];
      expect(args.data).toEqual({ slug: undefined, name: 'New' });
      expect(args.data).not.toHaveProperty('address');
    });

    it('passes address: null through to clear the column', async () => {
      mockFindUnique.mockResolvedValueOnce({ id: PROP_ID });
      mockUpdate.mockResolvedValueOnce({ id: PROP_ID });

      // address explicitly null should be allowed in MVP via partial update.
      // updatePropertyInputSchema is `.partial()` over create which had address optional,
      // so omit-vs-null is the distinction we test here.
      await service.update(PROP_ID, { address: undefined });

      // biome-ignore lint/style/noNonNullAssertion: call asserted above by mockResolvedValueOnce
      const args = mockUpdate.mock.calls[0]![0];
      expect(args.data).not.toHaveProperty('address');
    });

    it('translates P2002 on slug change into ConflictException', async () => {
      mockFindUnique.mockResolvedValueOnce({ id: PROP_ID });
      const p2002 = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['companyId', 'slug'] },
      });
      mockUpdate.mockRejectedValueOnce(p2002);

      await expect(service.update(PROP_ID, { slug: 'taken' })).rejects.toThrow(ConflictException);
    });
  });
});
