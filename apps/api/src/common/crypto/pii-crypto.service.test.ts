import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock env FIRST — the PiiCryptoService constructor reads `env.PII_ENCRYPTION_KEY`
 * at the moment the class is instantiated. If we let the real env.ts run
 * against `process.env` in unit tests it throws ZodError on missing JWT_SECRET
 * / R2_* and the test file never imports anything.
 *
 * vi.mock is hoisted by SWC, so this runs before the `./pii-crypto.service`
 * import below even though it appears after it textually.
 */
vi.mock('../../config/env.js', () => ({
  env: {
    PII_ENCRYPTION_KEY: 'test-key-which-is-at-least-32-chars-long-x',
  },
}));

const mockQueryRaw = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: { $queryRaw: mockQueryRaw },
}));

const { PiiCryptoService } = await import('./pii-crypto.service.js');

/**
 * Unit tests for PiiCryptoService — DB-free. We can't exercise actual pgcrypto
 * round-trips here (e2e concern); these tests verify the contract:
 *   - null/undefined inputs short-circuit to null (no DB round-trip)
 *   - Non-null inputs produce a single $queryRaw call and unwrap the row
 *   - Empty result rows raise an error (catches schema/migration drift)
 */
describe('PiiCryptoService', () => {
  let service: InstanceType<typeof PiiCryptoService>;

  beforeEach(() => {
    mockQueryRaw.mockReset();
    service = new PiiCryptoService();
  });

  describe('encrypt', () => {
    it('returns null when input is null (no DB round-trip)', async () => {
      await expect(service.encrypt(null)).resolves.toBeNull();
      expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it('returns null when input is undefined (no DB round-trip)', async () => {
      await expect(service.encrypt(undefined)).resolves.toBeNull();
      expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it('returns the base64 ciphertext from the first row', async () => {
      mockQueryRaw.mockResolvedValueOnce([{ ciphertext: 'BASE64-CIPHERTEXT' }]);
      await expect(service.encrypt('1234567890123')).resolves.toBe('BASE64-CIPHERTEXT');
      expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });

    it('throws when Postgres returns an empty result (schema drift)', async () => {
      mockQueryRaw.mockResolvedValueOnce([]);
      await expect(service.encrypt('1234567890123')).rejects.toThrow(/empty result/);
    });
  });

  describe('decrypt', () => {
    it('returns null when input is null (no DB round-trip)', async () => {
      await expect(service.decrypt(null)).resolves.toBeNull();
      expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it('returns null when input is undefined (no DB round-trip)', async () => {
      await expect(service.decrypt(undefined)).resolves.toBeNull();
      expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it('returns the plaintext from the first row', async () => {
      mockQueryRaw.mockResolvedValueOnce([{ plaintext: '1234567890123' }]);
      await expect(service.decrypt('BASE64-CIPHERTEXT')).resolves.toBe('1234567890123');
      expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });

    it('returns null when pgp_sym_decrypt yields null (legitimate empty cell)', async () => {
      mockQueryRaw.mockResolvedValueOnce([{ plaintext: null }]);
      await expect(service.decrypt('BASE64-CIPHERTEXT')).resolves.toBeNull();
    });

    it('throws when Postgres returns an empty result (schema drift)', async () => {
      mockQueryRaw.mockResolvedValueOnce([]);
      await expect(service.decrypt('BASE64-CIPHERTEXT')).rejects.toThrow(/empty result/);
    });
  });
});
