import { z } from 'zod';

/**
 * Server-side env vars consumed by Server Components, Route Handlers, and
 * middleware. None of these are exposed to the client bundle (Next only
 * inlines `NEXT_PUBLIC_*` vars).
 *
 * Validated once at module import. A missing/typo'd var fails fast at the
 * server boot rather than producing `undefined` requests at runtime.
 *
 * NOTE: This module must NOT be imported from a Client Component. Use the
 * `env.client.ts` variant for anything the browser needs.
 */
const serverEnvSchema = z.object({
  /**
   * Backend API base URL — no trailing slash. Examples:
   *   - dev:  http://localhost:3000
   *   - prod: https://api.example.com
   *
   * Used by Server Components / Server Actions to call the NestJS API.
   */
  API_URL: z.string().url('API_URL must be a valid URL'),
  /**
   * Same JWT secret apps/api uses to sign admin tokens. Middleware verifies
   * the cookie with `jose` to gate /c/[slug]/* routes.
   */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be ≥32 chars'),
  /**
   * Public-facing app URL — used for absolute URLs in emails / OAuth callbacks.
   * Optional in dev (defaults to http://localhost:3001).
   */
  APP_URL: z.string().url().default('http://localhost:3001'),
});

const parsed = serverEnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[env] invalid server env config:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid server env — see console for details');
}

export const env = Object.freeze(parsed.data);
