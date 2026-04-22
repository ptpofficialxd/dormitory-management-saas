import { z } from 'zod';
import { companyIdSchema, uuidSchema } from './primitives.js';

/**
 * Per-tenant LINE Official Account configuration.
 *
 * In MVP each company maps to exactly ONE LINE OA — enforced by a unique
 * index on `companyId`. Multi-OA per company (e.g. one channel per
 * property / language) is a future migration; the data model leaves room
 * for it (drop the unique, add a `name` column, expose channel selector).
 *
 * Secrets (`channelSecret`, `channelAccessToken`) are encrypted at rest
 * via `PiiCryptoService`. The Zod schemas below describe the
 * **DECRYPTED** view — the service layer encrypts/decrypts at the DB
 * boundary, and ciphertext NEVER crosses the API boundary.
 */

/**
 * LINE channelId — LINE's webhook URL routes by this value
 * (`POST /webhooks/line/:channelId`), so it MUST be globally unique.
 *
 * Format: numeric string. LINE assigns 10-digit IDs in practice, but we
 * allow up to 32 digits for forward-compat (the column is `VarChar(32)`).
 * Validating digits-only at the Zod boundary catches typos in admin input
 * before hitting the DB unique-index error path.
 */
export const lineChannelIdSchema = z
  .string()
  .regex(/^\d{8,32}$/, 'LINE channelId must be 8-32 digits');
export type LineChannelId = z.infer<typeof lineChannelIdSchema>;

/**
 * LINE channel secret — 32 hex chars per LINE's docs (HMAC-SHA256 key
 * for X-Line-Signature). Validated in plaintext form at the Zod boundary;
 * the service layer encrypts before INSERT.
 */
export const lineChannelSecretSchema = z
  .string()
  .regex(/^[a-f0-9]{32}$/i, 'LINE channelSecret must be 32 hex chars');
export type LineChannelSecret = z.infer<typeof lineChannelSecretSchema>;

/**
 * LINE channel access token — long-lived OR stateless v2.1 JWT.
 *
 * Length range chosen to cover both:
 *   - Legacy long-lived: ~170 chars opaque base64-ish
 *   - Stateless channel-access-token v2.1: JWT, 250-700+ chars
 *
 * No format regex because LINE has shipped multiple token shapes and
 * may ship more — we accept a printable-ASCII string of plausible length
 * and let the LINE API itself reject bad tokens at push/reply time.
 */
export const lineChannelAccessTokenSchema = z
  .string()
  .min(64)
  .max(1024)
  .regex(/^[A-Za-z0-9._\-+/=]+$/, 'LINE channelAccessToken must be base64-url / JWT-safe ASCII');
export type LineChannelAccessToken = z.infer<typeof lineChannelAccessTokenSchema>;

/**
 * LINE OA basic ID — the `@xxx` handle shown in the LINE app. Optional
 * (some channels expose only a numeric ID). LINE caps at 20 chars but we
 * leave headroom; `^@` prefix is required so admins can paste it as-is
 * from the LINE OA dashboard.
 */
export const lineBasicIdSchema = z
  .string()
  .regex(/^@[a-z0-9._-]{2,32}$/i, 'LINE basic ID must start with @ and be 3-33 chars total');
export type LineBasicId = z.infer<typeof lineBasicIdSchema>;

// -------------------------------------------------------------------------
// Persistent shape (decrypted view)
// -------------------------------------------------------------------------

/**
 * Full row as returned by the API (after decrypt).
 *
 * NOTE: this shape leaks decrypted secrets. It is ONLY safe for the
 * webhook signature-verify path (server-internal). Admin-facing endpoints
 * MUST project to `companyLineChannelPublicSchema` below — never return
 * the secret/access-token to the browser.
 */
export const companyLineChannelSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  channelId: lineChannelIdSchema,
  channelSecret: lineChannelSecretSchema,
  channelAccessToken: lineChannelAccessTokenSchema,
  basicId: lineBasicIdSchema.nullable(),
  displayName: z.string().min(1).max(128).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type CompanyLineChannel = z.infer<typeof companyLineChannelSchema>;

/**
 * Public-safe view — never includes the secret or access token. Use this
 * for any response the admin browser sees. Indicates whether secrets are
 * configured via `hasChannelSecret` / `hasChannelAccessToken` booleans so
 * the UI can show "Configured" vs "Set me up" without leaking the value.
 */
export const companyLineChannelPublicSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  channelId: lineChannelIdSchema,
  basicId: lineBasicIdSchema.nullable(),
  displayName: z.string().min(1).max(128).nullable(),
  hasChannelSecret: z.boolean(),
  hasChannelAccessToken: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type CompanyLineChannelPublic = z.infer<typeof companyLineChannelPublicSchema>;

// -------------------------------------------------------------------------
// Inputs
// -------------------------------------------------------------------------

/**
 * Input for `PUT /c/:slug/line-channel` — upsert (create OR replace).
 *
 * We use UPSERT (not separate POST + PATCH) because:
 *   - There can only be one row per company (unique on companyId).
 *   - Admins re-paste credentials when LINE rotates them; idempotent
 *     replace is the natural mental model.
 *   - Avoids the "do I already have one?" round-trip for the UI.
 */
export const upsertCompanyLineChannelInputSchema = z.object({
  channelId: lineChannelIdSchema,
  channelSecret: lineChannelSecretSchema,
  channelAccessToken: lineChannelAccessTokenSchema,
  basicId: lineBasicIdSchema.optional(),
  displayName: z.string().min(1).max(128).optional(),
});
export type UpsertCompanyLineChannelInput = z.infer<typeof upsertCompanyLineChannelInputSchema>;
