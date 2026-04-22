import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for CompanyLineChannelService — mocks `@dorm/db` AND injects
 * a fake `PiiCryptoService`. Asserts:
 *
 *   - getForCurrentCompany     : pulls companyId from tenant context, projects to PUBLIC view (no secrets)
 *   - upsert                   : encrypts BOTH credentials before INSERT/UPDATE, returns PUBLIC view
 *   - findByChannelIdUnscoped  : opens its OWN bypass-RLS boundary (asserted via withTenant call args),
 *                                returns DECRYPTED secrets to the internal caller
 *   - findByChannelIdUnscoped  : returns null on miss
 *   - findByChannelIdUnscoped  : throws if a row exists but credentials fail to decrypt (key rotation guard)
 *
 * pgcrypto round-trips + RLS isolation live in the e2e suite (Postgres-only).
 */

const mockUpsert = vi.fn();
const mockFindUnique = vi.fn();
const mockGetTenantContext = vi.fn();
const mockWithTenant = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    companyLineChannel: {
      findUnique: mockFindUnique,
      upsert: mockUpsert,
    },
  },
  getTenantContext: mockGetTenantContext,
  withTenant: mockWithTenant,
  Prisma: {},
}));

const { CompanyLineChannelService } = await import('./company-line-channel.service.js');

const COMPANY_ID = '22222222-2222-2222-8222-222222222222';
const CHANNEL_ROW_ID = '99999999-9999-9999-8999-999999999999';
const CHANNEL_ID = '1234567890';
const CHANNEL_SECRET = '0123456789abcdef0123456789abcdef';
// Realistic-shaped LINE long-lived token (≥64 chars, base64-url-safe).
const ACCESS_TOKEN =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/abcdefghijklmnop';

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

describe('CompanyLineChannelService', () => {
  let crypto: FakeCrypto;
  let service: InstanceType<typeof CompanyLineChannelService>;

  beforeEach(() => {
    mockUpsert.mockReset();
    mockFindUnique.mockReset();
    mockGetTenantContext.mockReset();
    mockWithTenant.mockReset();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });
    // Default: withTenant just runs the inner fn (RLS is mocked at the prisma boundary anyway).
    mockWithTenant.mockImplementation(async (_ctx: unknown, fn: () => Promise<unknown>) => fn());
    crypto = new FakeCrypto();
    // biome-ignore lint/suspicious/noExplicitAny: structural typing across test boundary
    service = new CompanyLineChannelService(crypto as any);
  });

  describe('getForCurrentCompany', () => {
    it('returns the public view (no secrets) when configured', async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: CHANNEL_ROW_ID,
        companyId: COMPANY_ID,
        channelId: CHANNEL_ID,
        channelSecret: 'ENC(secret)',
        channelAccessToken: 'ENC(token)',
        basicId: '@dormhq',
        displayName: 'Dorm HQ',
        createdAt: new Date('2026-04-22T00:00:00Z'),
        updatedAt: new Date('2026-04-22T00:00:00Z'),
      });

      const out = await service.getForCurrentCompany();
      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockFindUnique.mock.calls[0]![0];
      expect(args.where).toEqual({ companyId: COMPANY_ID });
      expect(out.channelId).toBe(CHANNEL_ID);
      expect(out.hasChannelSecret).toBe(true);
      expect(out.hasChannelAccessToken).toBe(true);
      // Crucially the public view MUST NOT carry the plaintext or ciphertext.
      expect(out).not.toHaveProperty('channelSecret');
      expect(out).not.toHaveProperty('channelAccessToken');
    });

    it('throws NotFoundException when the company has not configured LINE yet', async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      await expect(service.getForCurrentCompany()).rejects.toThrow(NotFoundException);
    });

    it('throws InternalServerErrorException when no tenant context is set', async () => {
      mockGetTenantContext.mockReturnValueOnce(undefined);
      await expect(service.getForCurrentCompany()).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('upsert', () => {
    it('encrypts both credentials, stamps companyId, and returns the public view', async () => {
      mockUpsert.mockResolvedValueOnce({
        id: CHANNEL_ROW_ID,
        companyId: COMPANY_ID,
        channelId: CHANNEL_ID,
        channelSecret: `ENC(${CHANNEL_SECRET})`,
        channelAccessToken: `ENC(${ACCESS_TOKEN})`,
        basicId: '@dormhq',
        displayName: 'Dorm HQ',
        createdAt: new Date('2026-04-22T00:00:00Z'),
        updatedAt: new Date('2026-04-22T00:00:00Z'),
      });

      const out = await service.upsert({
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
        channelAccessToken: ACCESS_TOKEN,
        basicId: '@dormhq',
        displayName: 'Dorm HQ',
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockUpsert.mock.calls[0]![0];
      expect(args.where).toEqual({ companyId: COMPANY_ID });
      expect(args.create.companyId).toBe(COMPANY_ID);
      expect(args.create.channelSecret).toBe(`ENC(${CHANNEL_SECRET})`);
      expect(args.create.channelAccessToken).toBe(`ENC(${ACCESS_TOKEN})`);
      expect(args.update.channelSecret).toBe(`ENC(${CHANNEL_SECRET})`);
      expect(args.update.channelAccessToken).toBe(`ENC(${ACCESS_TOKEN})`);
      // Both credentials must be encrypted in parallel (one call each).
      expect(crypto.encrypt).toHaveBeenCalledTimes(2);
      // Response is the public view.
      expect(out.hasChannelSecret).toBe(true);
      expect(out.hasChannelAccessToken).toBe(true);
      expect(out).not.toHaveProperty('channelSecret');
      expect(out).not.toHaveProperty('channelAccessToken');
    });

    it('passes through optional basicId/displayName as null when omitted', async () => {
      mockUpsert.mockResolvedValueOnce({
        id: CHANNEL_ROW_ID,
        companyId: COMPANY_ID,
        channelId: CHANNEL_ID,
        channelSecret: `ENC(${CHANNEL_SECRET})`,
        channelAccessToken: `ENC(${ACCESS_TOKEN})`,
        basicId: null,
        displayName: null,
        createdAt: new Date('2026-04-22T00:00:00Z'),
        updatedAt: new Date('2026-04-22T00:00:00Z'),
      });

      await service.upsert({
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
        channelAccessToken: ACCESS_TOKEN,
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockUpsert.mock.calls[0]![0];
      expect(args.create.basicId).toBeNull();
      expect(args.create.displayName).toBeNull();
      expect(args.update.basicId).toBeNull();
      expect(args.update.displayName).toBeNull();
    });

    it('throws InternalServerErrorException when no tenant context is set', async () => {
      mockGetTenantContext.mockReturnValueOnce(undefined);
      await expect(
        service.upsert({
          channelId: CHANNEL_ID,
          channelSecret: CHANNEL_SECRET,
          channelAccessToken: ACCESS_TOKEN,
        }),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('findByChannelIdUnscoped', () => {
    it('opens a bypass-RLS boundary for the lookup', async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: CHANNEL_ROW_ID,
        companyId: COMPANY_ID,
        channelId: CHANNEL_ID,
        channelSecret: `ENC(${CHANNEL_SECRET})`,
        channelAccessToken: `ENC(${ACCESS_TOKEN})`,
        basicId: null,
        displayName: null,
        createdAt: new Date('2026-04-22T00:00:00Z'),
        updatedAt: new Date('2026-04-22T00:00:00Z'),
      });

      await service.findByChannelIdUnscoped(CHANNEL_ID);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const ctx = mockWithTenant.mock.calls[0]![0];
      expect(ctx).toEqual({ companyId: '', bypassRls: true });
      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const findArgs = mockFindUnique.mock.calls[0]![0];
      expect(findArgs.where).toEqual({ channelId: CHANNEL_ID });
    });

    it('returns the row with credentials DECRYPTED for the internal caller', async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: CHANNEL_ROW_ID,
        companyId: COMPANY_ID,
        channelId: CHANNEL_ID,
        channelSecret: `ENC(${CHANNEL_SECRET})`,
        channelAccessToken: `ENC(${ACCESS_TOKEN})`,
        basicId: '@dormhq',
        displayName: 'Dorm HQ',
        createdAt: new Date('2026-04-22T00:00:00Z'),
        updatedAt: new Date('2026-04-22T00:00:00Z'),
      });

      const out = await service.findByChannelIdUnscoped(CHANNEL_ID);
      expect(out).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: out asserted not-null above
      expect(out!.channelSecret).toBe(CHANNEL_SECRET);
      // biome-ignore lint/style/noNonNullAssertion: out asserted not-null above
      expect(out!.channelAccessToken).toBe(ACCESS_TOKEN);
      // biome-ignore lint/style/noNonNullAssertion: out asserted not-null above
      expect(out!.companyId).toBe(COMPANY_ID);
    });

    it('returns null on miss (controller decides whether to 404 or ack)', async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      const out = await service.findByChannelIdUnscoped('9999999999');
      expect(out).toBeNull();
    });

    it('throws when ciphertext fails to decrypt (key-rotation safety net)', async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: CHANNEL_ROW_ID,
        companyId: COMPANY_ID,
        channelId: CHANNEL_ID,
        channelSecret: 'ENC(secret)',
        channelAccessToken: 'ENC(token)',
        basicId: null,
        displayName: null,
        createdAt: new Date('2026-04-22T00:00:00Z'),
        updatedAt: new Date('2026-04-22T00:00:00Z'),
      });
      // Force decrypt to return null (simulates wrong key / corrupted ciphertext).
      crypto.decrypt.mockResolvedValue(null);

      await expect(service.findByChannelIdUnscoped(CHANNEL_ID)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
