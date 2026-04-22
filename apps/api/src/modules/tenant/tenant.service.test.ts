import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for TenantService — mocks `@dorm/db` AND injects a fake
 * `PiiCryptoService` so we exercise:
 *   - companyId stamping from tenant context on INSERT
 *   - PII encrypt-on-write / decrypt-on-read flow (assert call args, not pgcrypto behaviour)
 *   - List filters AND-combine + cursor keyset
 *   - 409 ConflictException on P2002 against (companyId, lineUserId)
 *   - 404 NotFoundException when getById misses
 *   - PATCH skips re-encrypting fields the caller didn't send (audit hygiene)
 *
 * pgcrypto round-trips + RLS isolation live in the e2e suite (Postgres-only).
 */

const mockTenantFindMany = vi.fn();
const mockTenantFindUnique = vi.fn();
const mockTenantCreate = vi.fn();
const mockTenantUpdate = vi.fn();
const mockGetTenantContext = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    tenant: {
      findMany: mockTenantFindMany,
      findUnique: mockTenantFindUnique,
      create: mockTenantCreate,
      update: mockTenantUpdate,
    },
  },
  getTenantContext: mockGetTenantContext,
  Prisma: {},
}));

const { TenantService } = await import('./tenant.service.js');

const COMPANY_ID = '22222222-2222-2222-8222-222222222222';
const TENANT_ID = '55555555-5555-5555-8555-555555555555';

class FakeCrypto {
  encrypt = vi.fn(async (plaintext: string | null | undefined) => {
    if (plaintext === null || plaintext === undefined) return null;
    return `ENC(${plaintext})`;
  });

  decrypt = vi.fn(async (ciphertext: string | null | undefined) => {
    if (ciphertext === null || ciphertext === undefined) return null;
    if (ciphertext.startsWith('ENC(') && ciphertext.endsWith(')')) {
      return ciphertext.slice(4, -1);
    }
    return ciphertext;
  });
}

describe('TenantService', () => {
  let crypto: FakeCrypto;
  let service: InstanceType<typeof TenantService>;

  beforeEach(() => {
    mockTenantFindMany.mockReset();
    mockTenantFindUnique.mockReset();
    mockTenantCreate.mockReset();
    mockTenantUpdate.mockReset();
    mockGetTenantContext.mockReset();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });
    crypto = new FakeCrypto();
    // biome-ignore lint/suspicious/noExplicitAny: structural typing across test boundary
    service = new TenantService(crypto as any);
  });

  describe('list', () => {
    it('queries with take=limit+1 and orderBy [createdAt desc, id desc]', async () => {
      mockTenantFindMany.mockResolvedValueOnce([]);
      await service.list({ limit: 20 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockTenantFindMany.mock.calls[0]![0];
      expect(args.take).toBe(21);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.where).toEqual({});
    });

    it('AND-combines status filter with cursor keyset', async () => {
      mockTenantFindMany.mockResolvedValueOnce([]);
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: '2026-04-15T00:00:00.000Z', id: TENANT_ID }),
        'utf8',
      ).toString('base64url');

      await service.list({ cursor, status: 'active', limit: 10 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockTenantFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({
        AND: [
          { status: 'active' },
          {
            OR: [
              { createdAt: { lt: new Date('2026-04-15T00:00:00.000Z') } },
              { createdAt: new Date('2026-04-15T00:00:00.000Z'), id: { lt: TENANT_ID } },
            ],
          },
        ],
      });
    });

    it('decrypts PII for every row before returning', async () => {
      mockTenantFindMany.mockResolvedValueOnce([
        {
          id: TENANT_ID,
          createdAt: new Date('2026-04-01T00:00:00Z'),
          nationalId: 'ENC(1234567890123)',
          phone: 'ENC(0812345678)',
        },
      ]);

      const page = await service.list({ limit: 20 });
      // biome-ignore lint/style/noNonNullAssertion: items[0] guaranteed by findMany resolved value above
      expect(page.items[0]!.nationalId).toBe('1234567890123');
      // biome-ignore lint/style/noNonNullAssertion: items[0] guaranteed by findMany resolved value above
      expect(page.items[0]!.phone).toBe('0812345678');
      expect(crypto.decrypt).toHaveBeenCalledTimes(2);
    });
  });

  describe('getById', () => {
    it('returns the row with PII decrypted on hit', async () => {
      mockTenantFindUnique.mockResolvedValueOnce({
        id: TENANT_ID,
        nationalId: 'ENC(1234567890123)',
        phone: null,
      });
      const out = await service.getById(TENANT_ID);
      expect(out.nationalId).toBe('1234567890123');
      expect(out.phone).toBeNull();
    });

    it('throws NotFoundException on miss', async () => {
      mockTenantFindUnique.mockResolvedValueOnce(null);
      await expect(service.getById(TENANT_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('encrypts PII, stamps companyId, and decrypts the returned row', async () => {
      mockTenantCreate.mockResolvedValueOnce({
        id: TENANT_ID,
        companyId: COMPANY_ID,
        lineUserId: 'U-line-123',
        displayName: 'Ice',
        pictureUrl: null,
        nationalId: 'ENC(1234567890123)',
        phone: 'ENC(0812345678)',
      });

      const out = await service.create({
        lineUserId: 'U-line-123',
        displayName: 'Ice',
        nationalId: '1234567890123',
        phone: '0812345678',
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const createArgs = mockTenantCreate.mock.calls[0]![0];
      expect(createArgs.data.companyId).toBe(COMPANY_ID);
      expect(createArgs.data.nationalId).toBe('ENC(1234567890123)');
      expect(createArgs.data.phone).toBe('ENC(0812345678)');
      expect(createArgs.data.pictureUrl).toBeNull();
      // Response is decrypted before returning to the controller
      expect(out.nationalId).toBe('1234567890123');
      expect(out.phone).toBe('0812345678');
    });

    it('passes through nulls when PII fields are omitted', async () => {
      mockTenantCreate.mockResolvedValueOnce({
        id: TENANT_ID,
        nationalId: null,
        phone: null,
      });

      await service.create({
        lineUserId: 'U-line-456',
        displayName: 'Anon',
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const createArgs = mockTenantCreate.mock.calls[0]![0];
      expect(createArgs.data.nationalId).toBeNull();
      expect(createArgs.data.phone).toBeNull();
    });

    it('translates P2002 on (companyId, lineUserId) into 409 ConflictException', async () => {
      const p2002 = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['companyId', 'lineUserId'] },
      });
      mockTenantCreate.mockRejectedValueOnce(p2002);

      await expect(service.create({ lineUserId: 'U-dup', displayName: 'Dup' })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    it('404s before any write when tenant is missing', async () => {
      mockTenantFindUnique.mockResolvedValueOnce(null);
      await expect(service.update(TENANT_ID, { displayName: 'X' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockTenantUpdate).not.toHaveBeenCalled();
    });

    it('does NOT re-encrypt PII fields the caller did not send', async () => {
      mockTenantFindUnique.mockResolvedValueOnce({
        id: TENANT_ID,
        nationalId: 'ENC(existing)',
        phone: 'ENC(existing-phone)',
      });
      mockTenantUpdate.mockResolvedValueOnce({
        id: TENANT_ID,
        nationalId: 'ENC(existing)',
        phone: 'ENC(existing-phone)',
      });

      await service.update(TENANT_ID, { displayName: 'New Display' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockTenantUpdate.mock.calls[0]![0];
      expect(args.data).not.toHaveProperty('nationalId');
      expect(args.data).not.toHaveProperty('phone');
      // crypto.encrypt only called from update path → 0 here (decrypt is for response read)
      expect(crypto.encrypt).not.toHaveBeenCalled();
    });

    it('encrypts only the PII field being updated', async () => {
      mockTenantFindUnique.mockResolvedValueOnce({ id: TENANT_ID });
      mockTenantUpdate.mockResolvedValueOnce({
        id: TENANT_ID,
        nationalId: 'ENC(9999999999999)',
        phone: 'ENC(existing-phone)',
      });

      await service.update(TENANT_ID, { nationalId: '9999999999999' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockTenantUpdate.mock.calls[0]![0];
      expect(args.data.nationalId).toBe('ENC(9999999999999)');
      expect(args.data).not.toHaveProperty('phone');
      expect(crypto.encrypt).toHaveBeenCalledTimes(1);
    });

    it('passes status through unchanged (no encryption)', async () => {
      mockTenantFindUnique.mockResolvedValueOnce({ id: TENANT_ID });
      mockTenantUpdate.mockResolvedValueOnce({
        id: TENANT_ID,
        nationalId: null,
        phone: null,
        status: 'moved_out',
      });

      await service.update(TENANT_ID, { status: 'moved_out' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockTenantUpdate.mock.calls[0]![0];
      expect(args.data.status).toBe('moved_out');
      expect(crypto.encrypt).not.toHaveBeenCalled();
    });
  });
});
