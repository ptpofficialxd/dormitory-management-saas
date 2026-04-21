import { z } from 'zod';

/**
 * Environment-variable schema. Fails fast on boot if any required variable
 * is missing or malformed. Runtime code reads through `env` (a frozen typed
 * object) rather than `process.env` directly.
 *
 * Secrets (JWT_SECRET, DATABASE_URL_APP) MUST be ≥32 chars — short secrets
 * are a red flag for dev leakage into prod.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** HTTP listen port for Fastify. */
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  // ---- Database -------------------------------------------------------
  /** Runtime app role — RLS-enforced. Used by @dorm/db. */
  DATABASE_URL_APP: z.string().url(),
  /** Admin role URL — only migrations / apply-rls. NEVER used at runtime. */
  DATABASE_URL: z.string().url().optional(),

  // ---- Redis (for future BullMQ / sessions) ---------------------------
  REDIS_URL: z.string().url().optional(),

  // ---- Auth -----------------------------------------------------------
  /** HS256 signing key. ≥32 chars per CLAUDE.md §7. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be ≥ 32 chars'),
  /** Access-token TTL. jose expects a string like `15m`, `1h`. */
  JWT_ACCESS_TTL: z.string().default('15m'),
  /** Refresh-token TTL. */
  JWT_REFRESH_TTL: z.string().default('30d'),

  // ---- Observability --------------------------------------------------
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppEnv = z.infer<typeof envSchema>;

/**
 * Validate `process.env` at module load. Any failure aborts boot with a
 * formatted error listing every missing/invalid variable — much better UX
 * than crashing 500ms into the first request.
 */
function loadEnv(): AppEnv {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return Object.freeze(result.data);
}

export const env = loadEnv();
