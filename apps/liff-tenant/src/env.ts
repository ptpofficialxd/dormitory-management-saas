import { z } from 'zod';

/**
 * Vite-managed env vars (must be `VITE_*` prefixed to be exposed to the client
 * bundle — anything else stays server-side and is unavailable here).
 *
 * Validated once at module import. A missing/typo'd var fails fast in the
 * console at app boot rather than silently producing `undefined` requests.
 */
const envSchema = z.object({
  /** Public LIFF app id from LINE Developer Console (numeric string e.g. "1234567890-AbCdEfGh"). */
  VITE_LIFF_ID: z.string().min(1, 'VITE_LIFF_ID is required'),
  /**
   * Backend API base URL — no trailing slash. Examples:
   *   - dev:  http://localhost:3000
   *   - prod: https://api.example.com
   */
  VITE_API_BASE_URL: z.string().url('VITE_API_BASE_URL must be a valid URL'),
});

const parsed = envSchema.safeParse(import.meta.env);

if (!parsed.success) {
  // Throw at import-time so the app never boots half-configured.
  console.error('[env] invalid VITE_* env config:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid client env — see console for details');
}

export const env = Object.freeze(parsed.data);
