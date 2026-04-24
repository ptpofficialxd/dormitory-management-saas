import { z } from 'zod';
import { tenantAuthTokenSchema } from './auth.js';
import { companyIdSchema, slugSchema, uuidSchema } from './primitives.js';

/**
 * TenantInvite (Task #41) — short-lived, single-use code that binds a LINE
 * user to a pre-existing Tenant row.
 *
 * Token format: 8 chars from a Crockford-style base32 alphabet (no I, L, O, U
 * — those collide visually on phones and handwriting), displayed with a
 * mid-hyphen so admins can read it aloud:
 *
 *     K7M3-XQ2P
 *
 * Storage:
 *   - Plaintext NEVER persists (server returns it once at generate time).
 *   - DB stores `codeHash` (SHA-256 hex) + `codePrefix` (first 4 chars) only.
 *   - Comparison at redeem is constant-time over the hash, scoped by prefix
 *     for index efficiency.
 *
 * The wire form for redeem is canonicalised (uppercase, hyphen optional) by
 * the schema so the user can paste/type either `k7m3-xq2p` or `K7M3XQ2P` and
 * the server always hashes the same 8-char string.
 */

// -------------------------------------------------------------------------
// Status enum (mirrors Prisma `tenant_invite_status`)
// -------------------------------------------------------------------------

export const tenantInviteStatusSchema = z.enum(['pending', 'redeemed', 'expired', 'revoked']);
export type TenantInviteStatus = z.infer<typeof tenantInviteStatusSchema>;

// -------------------------------------------------------------------------
// Code primitives
// -------------------------------------------------------------------------

/**
 * Crockford-style alphabet (no I, L, O, U). 32 symbols → 5 bits per char →
 * 8 chars = 40 bits of entropy. With a 7-day TTL + status='pending' CAS +
 * single-use, online brute-force is infeasible (each redeem attempt is
 * 1 DB roundtrip; 2^40 attempts ≈ 1 trillion roundtrips).
 */
export const TENANT_INVITE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' as const;

/** Length of the plaintext code (excluding the display hyphen). */
export const TENANT_INVITE_CODE_LENGTH = 8 as const;

/** Length of the prefix indexed in DB for admin lookup ergonomics. */
export const TENANT_INVITE_CODE_PREFIX_LENGTH = 4 as const;

/** Default TTL for a freshly minted invite — 7 days. */
export const TENANT_INVITE_TTL_DAYS = 7 as const;

/**
 * Plaintext invite code accepted on the wire — case-insensitive, hyphen
 * optional. Refines into the canonical 8-char uppercase form after stripping
 * `-` so the service hashes a single representation.
 */
export const tenantInviteCodeSchema = z
  .string()
  .min(8)
  .max(9)
  .transform((s) => s.replace(/-/g, '').toUpperCase())
  .pipe(
    z
      .string()
      .length(TENANT_INVITE_CODE_LENGTH, 'Invite code must be 8 characters (excluding hyphen)')
      .regex(
        /^[0-9A-HJKMNP-TV-Z]+$/,
        'Invite code contains invalid characters (use 0-9 A-Z, no I L O U)',
      ),
  );

// -------------------------------------------------------------------------
// Full row (admin view) — server → admin client
// -------------------------------------------------------------------------

export const tenantInviteSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  tenantId: uuidSchema,
  /** First 4 chars of the plaintext — safe to show in admin UI. */
  codePrefix: z.string().length(TENANT_INVITE_CODE_PREFIX_LENGTH),
  status: tenantInviteStatusSchema,
  expiresAt: z.date(),
  redeemedAt: z.date().nullable(),
  redeemedByLineUserId: z.string().min(1).max(64).nullable(),
  createdAt: z.date(),
  createdByUserId: uuidSchema,
});
export type TenantInvite = z.infer<typeof tenantInviteSchema>;

/**
 * Generate response — the ONE place the plaintext code is returned. Admin
 * UI surfaces this once + offers a copy-to-clipboard button. After this
 * response, plaintext is unrecoverable; admin must regenerate to share again.
 */
export const generateTenantInviteResponseSchema = z.object({
  invite: tenantInviteSchema,
  /** Plaintext code in display form `XXXX-XXXX` — server returns ONCE. */
  code: z.string().length(TENANT_INVITE_CODE_LENGTH + 1),
});
export type GenerateTenantInviteResponse = z.infer<typeof generateTenantInviteResponseSchema>;

// -------------------------------------------------------------------------
// Admin endpoints
// -------------------------------------------------------------------------

/**
 * Body for `POST /admin/tenants/:tenantId/invites`. Empty in MVP — the path
 * already names the tenant + TTL is fixed at 7 days. Kept as an object (not
 * a `z.void()`) so future fields (custom TTL, single-use vs reusable, etc.)
 * don't need a controller-signature break.
 */
export const generateTenantInviteInputSchema = z.object({}).passthrough();
export type GenerateTenantInviteInput = z.infer<typeof generateTenantInviteInputSchema>;

/** Body for `POST /admin/tenant-invites/:id/revoke`. */
export const revokeTenantInviteInputSchema = z.object({
  /** Optional admin note — written to the audit log alongside the revoke. */
  reason: z.string().min(1).max(255).optional(),
});
export type RevokeTenantInviteInput = z.infer<typeof revokeTenantInviteInputSchema>;

/** Query for `GET /admin/tenants/:tenantId/invites` — list invites per tenant. */
export const listTenantInvitesQuerySchema = z.object({
  status: tenantInviteStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListTenantInvitesQuery = z.infer<typeof listTenantInvitesQuerySchema>;

// -------------------------------------------------------------------------
// Public LIFF endpoints
// -------------------------------------------------------------------------

/**
 * Preview body for `POST /liff/invites/peek`. Tenant types the code; we
 * return a redacted Tenant snapshot so they can confirm "yes, that's me /
 * my room" before binding. No LINE idToken required for peek (read-only,
 * narrow lookup) — but rate-limited at the controller layer.
 */
export const peekTenantInviteInputSchema = z.object({
  code: tenantInviteCodeSchema,
});
export type PeekTenantInviteInput = z.infer<typeof peekTenantInviteInputSchema>;

/**
 * Redacted preview returned by `/peek`. Show enough so the human recognises
 * themselves but NEVER returns a row that could be used to enumerate
 * tenants (no full name, no national ID, no phone). Display name is
 * truncated to first char + dots: `น.ส. ก****`.
 */
export const tenantInvitePreviewSchema = z.object({
  inviteId: uuidSchema,
  /** Truncated display name (e.g. "ก****"). */
  tenantDisplayHint: z.string().min(1).max(64),
  /** Unit number (e.g. "305") so the human can sanity-check the room. */
  unitNumber: z.string().min(1).max(32).nullable(),
  /** Property name (e.g. "อาคาร A"). */
  propertyName: z.string().min(1).max(128).nullable(),
  expiresAt: z.date(),
});
export type TenantInvitePreview = z.infer<typeof tenantInvitePreviewSchema>;

/**
 * Body for `POST /liff/invites/redeem`. The LINE idToken is the proof-of-
 * identity — server verifies it against `LIFF_LOGIN_CHANNEL_ID` (the
 * channel ID matching the LIFF app, NOT the OA messaging channel) and
 * extracts `sub` as the lineUserId. Client also sends the code so the
 * server can re-resolve the same invite atomically.
 */
export const redeemTenantInviteInputSchema = z.object({
  code: tenantInviteCodeSchema,
  /**
   * LIFF `liff.getIDToken()` value. JWT signed by LINE; verified server-side
   * (signature + iss=`https://access.line.me` + aud=channelId + exp).
   * We deliberately do NOT trust a client-supplied `lineUserId` — it MUST
   * come from the verified `sub` claim.
   */
  lineIdToken: z.string().min(16).max(8192),
});
export type RedeemTenantInviteInput = z.infer<typeof redeemTenantInviteInputSchema>;

/**
 * Redeem success response. `companySlug` is included so LIFF can route to
 * `/c/:companySlug/*` after bind without a separate lookup.
 *
 * Includes a freshly-minted tenant JWT as a first-time-bind UX optimisation —
 * LIFF can hop straight into authenticated `/me/*` routes without a follow-up
 * `POST /me/auth/exchange` round-trip.
 *
 * The token is OPTIONAL on the schema (service-level redeem returns the bind
 * result; the controller bolts the token on top). LIFF treats absence as
 * "fall back to exchange flow".
 */
export const redeemTenantInviteResponseSchema = z.object({
  tenantId: uuidSchema,
  companyId: companyIdSchema,
  companySlug: slugSchema,
  redeemedAt: z.date(),
  token: tenantAuthTokenSchema.optional(),
});
export type RedeemTenantInviteResponse = z.infer<typeof redeemTenantInviteResponseSchema>;
