import { z } from 'zod';

/**
 * Server-side env vars consumed by Server Components, Server Actions,
 * Route Handlers, and middleware.
 *
 * Lazy validation via Proxy:
 * - We do NOT validate at module-import time.
 * - Reason: `next build` walks every page module to collect data (metadata,
 *   generateStaticParams, etc.). During that walk, modules are imported but
 *   their code is not necessarily executed — yet a top-level `safeParse` +
 *   throw would still fire and break the build with "Required" for vars
 *   that don't exist at build time (e.g. CI without `.env` mounted).
 * - The Proxy defers `safeParse` until the FIRST property access, which
 *   only happens when an actual request hits a code path that needs the
 *   value (api.post → env.API_URL, auth → env.JWT_SECRET).
 *
 * NOTE: This module must NOT be imported from a Client Component. Next
 * inlines `NEXT_PUBLIC_*` vars but anything else stays server-side and
 * `process.env.X` would be `undefined` in the browser bundle.
 */
const serverEnvSchema = z.object({
  /**
   * Backend API base URL — no trailing slash. Examples:
   *   - dev:  http://localhost:3000
   *   - prod: https://api.example.com
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

type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

function load(): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('[env] invalid server env config:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid server env — see console for details');
  }
  cached = Object.freeze(parsed.data);
  return cached;
}

/**
 * Validated server env. The Proxy defers the actual `safeParse` until the
 * first key access, so importing this file at build time is side-effect free.
 *
 * Usage stays the same as a plain object: `env.JWT_SECRET`, `env.API_URL`.
 */
export const env = new Proxy({} as ServerEnv, {
  get(_target, prop) {
    return load()[prop as keyof ServerEnv];
  },
});
