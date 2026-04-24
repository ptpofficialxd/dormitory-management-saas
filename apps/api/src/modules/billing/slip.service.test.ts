import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for SlipService — mocks `@dorm/db` + StorageService to keep
 * the suite DB-/network-free.
 *
 * Coverage focus:
 *   - createUploadUrl
 *       - tenant context required (500 if missing)
 *       - Payment must exist (404), be `pending` (409), have no slip (409)
 *       - r2ObjectKey built deterministically with the right prefix + ext
 *       - Storage.generateUploadUrl called with sizeBytes signed in
 *
 *   - register
 *       - tenant context required
 *       - Payment must be visible + pending + slip-less
 *       - r2ObjectKey prefix MUST match `companies/{cid}/slips/{pid}/`
 *         (cross-tenant tampering rejected with 400)
 *       - HEAD null → 400 SlipNotUploaded
 *       - HEAD size mismatch → 400 SlipSizeMismatch
 *       - P2002 on `payment_id` (race window) → 409 SlipAlreadyExists
 *
 *   - getViewUrl
 *       - 404 on missing slip
 *       - Storage.generateDownloadUrl wired with the persisted r2ObjectKey
 *
 *   - read paths
 *       - getById / getByPaymentId 404 + happy
 *
 * RLS cross-company isolation is asserted in the e2e suite (Postgres-only).
 */

const mockSlipFindUnique = vi.fn();
const mockSlipFindFirst = vi.fn();
const mockSlipCreate = vi.fn();
const mockPaymentFindUnique = vi.fn();
const mockGetTenantContext = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    slip: {
      findUnique: mockSlipFindUnique,
      findFirst: mockSlipFindFirst,
      create: mockSlipCreate,
    },
    payment: {
      findUnique: mockPaymentFindUnique,
    },
  },
  getTenantContext: mockGetTenantContext,
  Prisma: {},
}));

const mockGenerateUploadUrl = vi.fn();
const mockGenerateDownloadUrl = vi.fn();
const mockHeadObject = vi.fn();

class MockStorageService {
  generateUploadUrl = mockGenerateUploadUrl;
  generateDownloadUrl = mockGenerateDownloadUrl;
  headObject = mockHeadObject;
}

const { SlipService } = await import('./slip.service.js');

const COMPANY_ID = '11111111-1111-1111-8111-111111111111';
const PAYMENT_ID = '22222222-2222-2222-8222-222222222222';
const FOREIGN_COMPANY_ID = '99999999-9999-9999-8999-999999999999';
const SLIP_ID = '33333333-3333-3333-8333-333333333333';
const VALID_SHA = 'a'.repeat(64);
const VALID_KEY = `companies/${COMPANY_ID}/slips/${PAYMENT_ID}/abc-uuid.jpg`;
const FOREIGN_KEY = `companies/${FOREIGN_COMPANY_ID}/slips/${PAYMENT_ID}/abc-uuid.jpg`;
const SIGNED_URL = 'https://acme.r2.cloudflarestorage.com/dorm-bucket/some/key?X-Amz-Signature=xxx';
const EXPIRES_AT = new Date('2026-04-22T10:30:00.000Z');

describe('SlipService', () => {
  let service: InstanceType<typeof SlipService>;

  beforeEach(() => {
    mockSlipFindUnique.mockReset();
    mockSlipFindFirst.mockReset();
    mockSlipCreate.mockReset();
    mockPaymentFindUnique.mockReset();
    mockGetTenantContext.mockReset();
    mockGenerateUploadUrl.mockReset();
    mockGenerateDownloadUrl.mockReset();
    mockHeadObject.mockReset();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });
    service = new SlipService(new MockStorageService() as never);
  });

  // ===================================================================
  // createUploadUrl
  // ===================================================================

  describe('createUploadUrl', () => {
    const VALID_INPUT = { mimeType: 'image/jpeg', sizeBytes: 500_000 } as const;

    it('throws InternalServerError when tenant context is missing', async () => {
      mockGetTenantContext.mockReturnValueOnce(null);
      await expect(service.createUploadUrl(PAYMENT_ID, VALID_INPUT)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws NotFound when payment is missing / not visible', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce(null);
      await expect(service.createUploadUrl(PAYMENT_ID, VALID_INPUT)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws Conflict when payment is not pending', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'confirmed',
        slip: null,
      });
      await expect(service.createUploadUrl(PAYMENT_ID, VALID_INPUT)).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws Conflict when payment already has a slip', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'pending',
        slip: { id: SLIP_ID },
      });
      await expect(service.createUploadUrl(PAYMENT_ID, VALID_INPUT)).rejects.toThrow(
        ConflictException,
      );
    });

    it('mints presigned PUT URL with correct key prefix + signed contentLength', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'pending',
        slip: null,
      });
      mockGenerateUploadUrl.mockResolvedValueOnce({ url: SIGNED_URL, expiresAt: EXPIRES_AT });

      const result = await service.createUploadUrl(PAYMENT_ID, VALID_INPUT);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockGenerateUploadUrl.mock.calls[0]![0];
      expect(args.contentType).toBe('image/jpeg');
      expect(args.contentLength).toBe(500_000);
      expect(args.key).toMatch(
        new RegExp(`^companies/${COMPANY_ID}/slips/${PAYMENT_ID}/[0-9a-f-]{36}\\.jpg$`),
      );
      expect(result.url).toBe(SIGNED_URL);
      expect(result.r2ObjectKey).toBe(args.key);
      expect(result.expiresAt).toBe(EXPIRES_AT.toISOString());
    });

    it('uses .pdf extension for application/pdf', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'pending',
        slip: null,
      });
      mockGenerateUploadUrl.mockResolvedValueOnce({ url: SIGNED_URL, expiresAt: EXPIRES_AT });

      const result = await service.createUploadUrl(PAYMENT_ID, {
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      });

      expect(result.r2ObjectKey).toMatch(/\.pdf$/);
    });

    it('uses .webp extension for image/webp', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'pending',
        slip: null,
      });
      mockGenerateUploadUrl.mockResolvedValueOnce({ url: SIGNED_URL, expiresAt: EXPIRES_AT });

      const result = await service.createUploadUrl(PAYMENT_ID, {
        mimeType: 'image/webp',
        sizeBytes: 1024,
      });

      expect(result.r2ObjectKey).toMatch(/\.webp$/);
    });
  });

  // ===================================================================
  // register
  // ===================================================================

  describe('register', () => {
    const VALID_INPUT = {
      r2ObjectKey: VALID_KEY,
      mimeType: 'image/jpeg' as const,
      sizeBytes: 500_000,
      sha256: VALID_SHA,
    };

    it('throws InternalServerError when tenant context is missing', async () => {
      mockGetTenantContext.mockReturnValueOnce(null);
      await expect(service.register(PAYMENT_ID, VALID_INPUT)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws NotFound when payment is missing', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce(null);
      await expect(service.register(PAYMENT_ID, VALID_INPUT)).rejects.toThrow(NotFoundException);
    });

    it('throws Conflict when payment is not pending', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'rejected',
        slip: null,
      });
      await expect(service.register(PAYMENT_ID, VALID_INPUT)).rejects.toThrow(ConflictException);
    });

    it('throws Conflict when payment already has a slip', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'pending',
        slip: { id: SLIP_ID },
      });
      await expect(service.register(PAYMENT_ID, VALID_INPUT)).rejects.toThrow(ConflictException);
    });

    it('rejects tampered r2ObjectKey targeting a foreign tenant namespace', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'pending',
        slip: null,
      });
      // Should never reach HEAD — prefix guard short-circuits.
      await expect(
        service.register(PAYMENT_ID, { ...VALID_INPUT, r2ObjectKey: FOREIGN_KEY }),
      ).rejects.toThrow(BadRequestException);
      expect(mockHeadObject).not.toHaveBeenCalled();
    });

    it('rejects r2ObjectKey targeting the wrong payment', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'pending',
        slip: null,
      });
      const otherPayment = '88888888-8888-8888-8888-888888888888';
      const wrongKey = `companies/${COMPANY_ID}/slips/${otherPayment}/abc.jpg`;
      await expect(
        service.register(PAYMENT_ID, { ...VALID_INPUT, r2ObjectKey: wrongKey }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequest when R2 HEAD reports the object is missing', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'pending',
        slip: null,
      });
      mockHeadObject.mockResolvedValueOnce(null);
      await expect(service.register(PAYMENT_ID, VALID_INPUT)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequest when R2-reported size differs from claimed size', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'pending',
        slip: null,
      });
      mockHeadObject.mockResolvedValueOnce({
        contentType: 'image/jpeg',
        contentLength: 999_999,
        etag: 'abc',
      });
      await expect(service.register(PAYMENT_ID, VALID_INPUT)).rejects.toThrow(BadRequestException);
      expect(mockSlipCreate).not.toHaveBeenCalled();
    });

    it('skips size cross-check when R2 HEAD does not return ContentLength', async () => {
      // Some S3-compatible backends omit ContentLength on HEAD; we treat
      // that as "trust the signed PUT enforcement" and proceed.
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'pending',
        slip: null,
      });
      mockHeadObject.mockResolvedValueOnce({
        contentType: 'image/jpeg',
        contentLength: undefined,
        etag: 'abc',
      });
      const created = { id: SLIP_ID, paymentId: PAYMENT_ID, r2ObjectKey: VALID_KEY };
      mockSlipCreate.mockResolvedValueOnce(created);
      await expect(service.register(PAYMENT_ID, VALID_INPUT)).resolves.toBe(created);
    });

    it('persists Slip row on happy path with all server-stamped fields', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'pending',
        slip: null,
      });
      mockHeadObject.mockResolvedValueOnce({
        contentType: 'image/jpeg',
        contentLength: 500_000,
        etag: 'abc',
      });
      const created = { id: SLIP_ID, paymentId: PAYMENT_ID, r2ObjectKey: VALID_KEY };
      mockSlipCreate.mockResolvedValueOnce(created);

      const result = await service.register(PAYMENT_ID, VALID_INPUT);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockSlipCreate.mock.calls[0]![0];
      expect(args.data).toEqual({
        companyId: COMPANY_ID,
        paymentId: PAYMENT_ID,
        r2ObjectKey: VALID_KEY,
        mimeType: 'image/jpeg',
        sizeBytes: 500_000,
        sha256: VALID_SHA,
      });
      expect(result).toBe(created);
    });

    it('translates P2002 on payment_id into 409 SlipAlreadyExists', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'pending',
        slip: null,
      });
      mockHeadObject.mockResolvedValueOnce({
        contentType: 'image/jpeg',
        contentLength: 500_000,
        etag: 'abc',
      });
      mockSlipCreate.mockRejectedValueOnce({
        code: 'P2002',
        meta: { target: ['payment_id'] },
      });
      await expect(service.register(PAYMENT_ID, VALID_INPUT)).rejects.toThrow(ConflictException);
    });

    it('rethrows unknown Prisma errors unchanged', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        companyId: COMPANY_ID,
        status: 'pending',
        slip: null,
      });
      mockHeadObject.mockResolvedValueOnce({
        contentType: 'image/jpeg',
        contentLength: 500_000,
        etag: 'abc',
      });
      const boom = new Error('Connection lost');
      mockSlipCreate.mockRejectedValueOnce(boom);
      await expect(service.register(PAYMENT_ID, VALID_INPUT)).rejects.toBe(boom);
    });
  });

  // ===================================================================
  // getViewUrl
  // ===================================================================

  describe('getViewUrl', () => {
    it('throws NotFound when slip is missing', async () => {
      mockSlipFindUnique.mockResolvedValueOnce(null);
      await expect(service.getViewUrl(SLIP_ID)).rejects.toThrow(NotFoundException);
    });

    it('mints presigned GET URL using the persisted r2ObjectKey', async () => {
      mockSlipFindUnique.mockResolvedValueOnce({ id: SLIP_ID, r2ObjectKey: VALID_KEY });
      mockGenerateDownloadUrl.mockResolvedValueOnce({ url: SIGNED_URL, expiresAt: EXPIRES_AT });

      const result = await service.getViewUrl(SLIP_ID);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockGenerateDownloadUrl.mock.calls[0]![0];
      expect(args.key).toBe(VALID_KEY);
      expect(result.url).toBe(SIGNED_URL);
      expect(result.expiresAt).toBe(EXPIRES_AT.toISOString());
    });
  });

  // ===================================================================
  // Read paths
  // ===================================================================

  describe('getById', () => {
    it('returns row on hit', async () => {
      const row = { id: SLIP_ID, paymentId: PAYMENT_ID };
      mockSlipFindUnique.mockResolvedValueOnce(row);
      await expect(service.getById(SLIP_ID)).resolves.toBe(row);
    });

    it('throws NotFound on miss', async () => {
      mockSlipFindUnique.mockResolvedValueOnce(null);
      await expect(service.getById(SLIP_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getByPaymentId', () => {
    it('returns row on hit', async () => {
      const row = { id: SLIP_ID, paymentId: PAYMENT_ID };
      mockSlipFindUnique.mockResolvedValueOnce(row);
      await expect(service.getByPaymentId(PAYMENT_ID)).resolves.toBe(row);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockSlipFindUnique.mock.calls[0]![0];
      expect(args.where).toEqual({ paymentId: PAYMENT_ID });
    });

    it('throws NotFound on miss', async () => {
      mockSlipFindUnique.mockResolvedValueOnce(null);
      await expect(service.getByPaymentId(PAYMENT_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getViewUrlForTenant — LIFF /me/slips/:id/view-url scope', () => {
    const TENANT_ID = '44444444-4444-4444-8444-444444444444';

    it('joins slip → payment.tenantId to enforce ownership', async () => {
      mockSlipFindFirst.mockResolvedValueOnce({ id: SLIP_ID, r2ObjectKey: VALID_KEY });
      mockGenerateDownloadUrl.mockResolvedValueOnce({ url: SIGNED_URL, expiresAt: EXPIRES_AT });

      const result = await service.getViewUrlForTenant(SLIP_ID, TENANT_ID);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockSlipFindFirst.mock.calls[0]![0];
      expect(args.where).toEqual({ id: SLIP_ID, payment: { tenantId: TENANT_ID } });
      expect(result.url).toBe(SIGNED_URL);
      expect(result.expiresAt).toBe(EXPIRES_AT.toISOString());
    });

    it('throws 404 (not 403) when slip belongs to a sibling tenant', async () => {
      mockSlipFindFirst.mockResolvedValueOnce(null);
      await expect(service.getViewUrlForTenant(SLIP_ID, TENANT_ID)).rejects.toThrow(
        NotFoundException,
      );
      // No URL minted for an inaccessible slip.
      expect(mockGenerateDownloadUrl).not.toHaveBeenCalled();
    });
  });
});
