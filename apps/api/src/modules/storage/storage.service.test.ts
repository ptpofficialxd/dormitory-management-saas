import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock env FIRST — the StorageService constructor reads `env.R2_*` at the
 * moment the class is instantiated. If we let the real env.ts run against
 * `process.env` in unit tests it throws ZodError and the test file never
 * imports anything.
 *
 * vi.mock is hoisted by SWC, so this runs before the `./storage.service`
 * import below even though it appears after it textually.
 */
vi.mock('../../config/env.js', () => ({
  env: {
    R2_ACCOUNT_ID: 'test-account-id',
    R2_ACCESS_KEY_ID: 'AKIATEST',
    R2_SECRET_ACCESS_KEY: 'secret-test-value',
    R2_BUCKET: 'dorm-test',
    R2_SIGNED_URL_TTL: 300,
  },
}));

/**
 * Stub the S3Client + presigner. We don't test that SigV4 produces a valid
 * signature — that's AWS SDK's job and already has ~2k unit tests. What we
 * test is: does OUR code pass the right Bucket/Key/ContentType into the
 * command objects, and does it handle the 404 contract correctly.
 */
const mockSend = vi.fn();
const mockGetSignedUrl = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class FakeS3Client {
    send = mockSend;
  }
  class FakePutObjectCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class FakeGetObjectCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class FakeHeadObjectCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class FakeDeleteObjectCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    S3Client: FakeS3Client,
    PutObjectCommand: FakePutObjectCommand,
    GetObjectCommand: FakeGetObjectCommand,
    HeadObjectCommand: FakeHeadObjectCommand,
    DeleteObjectCommand: FakeDeleteObjectCommand,
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

const { ID_CARD_MAX_TTL_SECONDS, StorageService } = await import('./storage.service.js');

describe('StorageService', () => {
  let service: InstanceType<typeof StorageService>;

  beforeEach(() => {
    mockSend.mockReset();
    mockGetSignedUrl.mockReset();
    service = new StorageService();
  });

  describe('generateUploadUrl', () => {
    it('signs a PUT with bucket + key + content-type', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://signed.example/put');
      const before = Date.now();

      const result = await service.generateUploadUrl({
        key: 'companies/c1/slips/p1/abc.jpg',
        contentType: 'image/jpeg',
        contentLength: 2048,
      });

      expect(result.url).toBe('https://signed.example/put');
      // expiresAt should be ~300s from now (default TTL)
      const ttlMs = result.expiresAt.getTime() - before;
      expect(ttlMs).toBeGreaterThanOrEqual(299_000);
      expect(ttlMs).toBeLessThanOrEqual(301_000);

      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      // biome-ignore lint/style/noNonNullAssertion: length asserted above
      const [, command, opts] = mockGetSignedUrl.mock.calls[0]!;
      expect(command.input).toEqual({
        Bucket: 'dorm-test',
        Key: 'companies/c1/slips/p1/abc.jpg',
        ContentType: 'image/jpeg',
        ContentLength: 2048,
      });
      expect(opts).toEqual({ expiresIn: 300 });
    });

    it('honours per-call expiresIn override', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://signed/put');
      await service.generateUploadUrl({
        key: 'k',
        contentType: 'image/png',
        expiresIn: 60,
      });
      // biome-ignore lint/style/noNonNullAssertion: call confirmed by mockResolvedValueOnce resolution
      expect(mockGetSignedUrl.mock.calls[0]![2]).toEqual({ expiresIn: 60 });
    });

    it('clamps TTL above 1hr down to 3600s (leak safety)', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://signed/put');
      await service.generateUploadUrl({
        key: 'k',
        contentType: 'image/png',
        expiresIn: 99_999,
      });
      // biome-ignore lint/style/noNonNullAssertion: call confirmed by mockResolvedValueOnce resolution
      expect(mockGetSignedUrl.mock.calls[0]![2]).toEqual({ expiresIn: 3600 });
    });

    it('clamps TTL below 30s up to 30s (R2 rejects <1s anyway)', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://signed/put');
      await service.generateUploadUrl({
        key: 'k',
        contentType: 'image/png',
        expiresIn: 5,
      });
      // biome-ignore lint/style/noNonNullAssertion: call confirmed by mockResolvedValueOnce resolution
      expect(mockGetSignedUrl.mock.calls[0]![2]).toEqual({ expiresIn: 30 });
    });
  });

  describe('generateDownloadUrl', () => {
    it('signs a GET with bucket + key', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://signed/get');
      const result = await service.generateDownloadUrl({ key: 'k/private.pdf' });
      expect(result.url).toBe('https://signed/get');
      // biome-ignore lint/style/noNonNullAssertion: call confirmed by mockResolvedValueOnce resolution
      const [, command] = mockGetSignedUrl.mock.calls[0]!;
      expect(command.input).toEqual({ Bucket: 'dorm-test', Key: 'k/private.pdf' });
    });
  });

  describe('headObject', () => {
    it('returns parsed metadata on 200', async () => {
      mockSend.mockResolvedValueOnce({
        ContentType: 'image/jpeg',
        ContentLength: 4096,
        ETag: '"abc123"',
      });
      const result = await service.headObject('some/key');
      expect(result).toEqual({
        contentType: 'image/jpeg',
        contentLength: 4096,
        etag: '"abc123"',
      });
    });

    it('returns null on 404 (SDK "NotFound" error name)', async () => {
      const notFound = Object.assign(new Error('not found'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });
      mockSend.mockRejectedValueOnce(notFound);
      await expect(service.headObject('missing')).resolves.toBeNull();
    });

    it('returns null when 404 arrives without the "NotFound" name', async () => {
      // Some AWS error marshalling paths lose the `name` but keep metadata.
      const genericErr = Object.assign(new Error('nope'), {
        $metadata: { httpStatusCode: 404 },
      });
      mockSend.mockRejectedValueOnce(genericErr);
      await expect(service.headObject('missing')).resolves.toBeNull();
    });

    it('rethrows non-404 errors (5xx should bubble up to caller)', async () => {
      const serverErr = Object.assign(new Error('boom'), {
        $metadata: { httpStatusCode: 500 },
      });
      mockSend.mockRejectedValueOnce(serverErr);
      await expect(service.headObject('k')).rejects.toThrow('boom');
    });
  });

  describe('deleteObject', () => {
    it('sends a DeleteObjectCommand with bucket + key', async () => {
      mockSend.mockResolvedValueOnce({});
      await service.deleteObject('k/to/delete');
      expect(mockSend).toHaveBeenCalledTimes(1);
      // biome-ignore lint/style/noNonNullAssertion: length asserted above
      const [command] = mockSend.mock.calls[0]!;
      expect(command.input).toEqual({ Bucket: 'dorm-test', Key: 'k/to/delete' });
    });
  });

  describe('ID_CARD_MAX_TTL_SECONDS', () => {
    it('is 300s per CLAUDE.md §9 (ID card signed URL cap)', () => {
      expect(ID_CARD_MAX_TTL_SECONDS).toBe(300);
    });
  });
});
