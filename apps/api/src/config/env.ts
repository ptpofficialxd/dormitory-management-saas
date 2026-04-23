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

  // ---- Redis (BullMQ + cache) -----------------------------------------
  /**
   * Redis connection URL (`redis://[:password@]host:port[/db]`).
   *
   * Required from Task #38 onwards — BullMQ queues + worker share this
   * connection. Dev infra (`bun run infra:start`) provides one at
   * `redis://localhost:6379`. Tests in `.env.test` get their own DB index
   * to avoid colliding with dev queues.
   */
  REDIS_URL: z.string().url(),

  // ---- Auth -----------------------------------------------------------
  /** HS256 signing key. ≥32 chars per CLAUDE.md §7. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be ≥ 32 chars'),
  /** Access-token TTL. jose expects a string like `15m`, `1h`. */
  JWT_ACCESS_TTL: z.string().default('15m'),
  /** Refresh-token TTL. */
  JWT_REFRESH_TTL: z.string().default('30d'),

  // ---- Cloudflare R2 (S3-compatible private object storage) -----------
  /**
   * R2 endpoint is derived from account ID:
   *   https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com
   * Account ID is the 32-char hex string from the R2 dashboard URL.
   */
  R2_ACCOUNT_ID: z.string().min(1, 'R2_ACCOUNT_ID is required'),
  R2_ACCESS_KEY_ID: z.string().min(1, 'R2_ACCESS_KEY_ID is required'),
  R2_SECRET_ACCESS_KEY: z.string().min(1, 'R2_SECRET_ACCESS_KEY is required'),
  R2_BUCKET: z.string().min(1, 'R2_BUCKET is required'),
  /**
   * Optional public CDN URL (Cloudflare custom domain bound to the bucket).
   * NOT used for slip / ID card / meter photo — those stay private with
   * short-TTL signed URLs per CLAUDE.md §9. Kept here for future assets
   * like company logo that are safe to serve publicly.
   */
  R2_PUBLIC_URL: z.string().url().optional(),
  /**
   * Default signed-URL TTL in seconds. Callers may override per-request
   * (e.g. ID card enforces ≤300s hard cap per CLAUDE.md §9). Default 300
   * (5 min) keeps us conservative by default.
   */
  R2_SIGNED_URL_TTL: z.coerce.number().int().min(30).max(3600).default(300),

  // ---- PII encryption (pgcrypto) --------------------------------------
  /**
   * Symmetric key for `pgp_sym_encrypt` / `pgp_sym_decrypt` over PII columns
   * (`tenant.national_id`, `tenant.phone`, …) per CLAUDE.md §3.8. ≥32 chars.
   *
   * Operational notes:
   *   - Lives in the API process env ONLY. NEVER stored in the DB.
   *   - Backups of the DB without this key are useless — the encrypted columns
   *     are opaque ciphertext.
   *   - Rotation = re-encrypt every row with the new key (Phase 2 migration).
   *     There is no on-the-fly key versioning in MVP.
   */
  PII_ENCRYPTION_KEY: z.string().min(32, 'PII_ENCRYPTION_KEY must be ≥ 32 chars'),

  // ---- LIFF (LINE Front-end Framework) --------------------------------
  /**
   * Public LIFF URL the LINE event worker hands tenants when they message
   * the OA before they are bound to a tenant record. We append a `?company=`
   * query string so the LIFF page can pre-select the right tenant on open.
   *
   * Format: full HTTPS URL pointing at our LIFF entry, e.g.
   *   https://liff.line.me/2000000000-aBcDeFg
   *
   * Defaulted to a clearly-fake placeholder so local development boots without
   * a real LIFF id — production MUST override via env. The worker logs a
   * warning when it serves the placeholder URL so we notice in dev.
   */
  LIFF_BIND_URL: z.string().url().default('https://liff.line.me/0000000000-placeholder'),

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
