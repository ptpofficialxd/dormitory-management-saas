import { z } from 'zod';
import { companyIdSchema, emailSchema, roleSchema, slugSchema, uuidSchema } from './primitives.js';

// -------------------------------------------------------------------------
// Admin (email/password) — Next.js admin dashboard path
// -------------------------------------------------------------------------

/**
 * Admin login. `companySlug` is required because the same email may register
 * at multiple companies — we need to know which tenancy to sign in to.
 * Routing is path-based (`/c/:companySlug/...`) per CLAUDE.md §3.5.
 */
export const loginAdminInputSchema = z.object({
  companySlug: slugSchema,
  email: emailSchema,
  /** Minimum for basic brute-force protection; real strength enforced on signup. */
  password: z.string().min(8).max(128),
});
export type LoginAdminInput = z.infer<typeof loginAdminInputSchema>;

/** Input for `POST /auth/refresh` — refresh-token rotation. */
export const refreshTokenInputSchema = z.object({
  refreshToken: z.string().min(16).max(4096),
});
export type RefreshTokenInput = z.infer<typeof refreshTokenInputSchema>;

/**
 * Admin access-token claims. Scoped to one company at a time — NEVER embed
 * multiple companyIds in a single JWT (one token → one tenant boundary).
 * `roles` is an array because RBAC supports multi-role assignments.
 */
export const adminJwtClaimsSchema = z.object({
  sub: uuidSchema, // user.id
  companyId: companyIdSchema,
  companySlug: slugSchema,
  email: emailSchema,
  roles: z.array(roleSchema).min(1),
  /** Token kind discriminator — prevents refresh-token reuse as access-token. */
  typ: z.enum(['access', 'refresh']),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type AdminJwtClaims = z.infer<typeof adminJwtClaimsSchema>;

/** Response body for `POST /auth/login` + `POST /auth/refresh`. */
export const authTokensSchema = z.object({
  accessToken: z.string().min(16),
  refreshToken: z.string().min(16),
  /** UNIX epoch seconds — when the access token expires. */
  accessTokenExpiresAt: z.number().int(),
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

// -------------------------------------------------------------------------
// LIFF tenant (LINE Login) — Vite React LIFF path
// -------------------------------------------------------------------------

/**
 * LIFF bootstrap. The LINE ID token is verified server-side against LINE's
 * JWKS + `aud` = tenant's `LINE_LOGIN_CHANNEL_ID` (per-tenant channel).
 * `companySlug` disambiguates the tenancy — same LINE user may be a tenant
 * at multiple dorms.
 */
export const loginLiffInputSchema = z.object({
  companySlug: slugSchema,
  /** LINE-issued ID token (JWT) — verified server-side. */
  idToken: z.string().min(1).max(4096),
});
export type LoginLiffInput = z.infer<typeof loginLiffInputSchema>;

/**
 * LIFF session claims. The LIFF session has no refresh flow — clients
 * re-run `liff.getIDToken()` when expired. Token lifetime = 1 hour matches
 * LINE's ID-token TTL.
 */
export const tenantJwtClaimsSchema = z.object({
  sub: uuidSchema, // tenant.id
  companyId: companyIdSchema,
  companySlug: slugSchema,
  lineUserId: z.string().min(1).max(64),
  typ: z.literal('liff'),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type TenantJwtClaims = z.infer<typeof tenantJwtClaimsSchema>;

/**
 * Tenant access-token envelope returned to LIFF. No refresh token — when
 * `accessTokenExpiresAt` passes, LIFF re-mints by exchanging a fresh
 * `liff.getIDToken()` at `POST /me/auth/exchange`.
 */
export const tenantAuthTokenSchema = z.object({
  accessToken: z.string().min(16),
  /** UNIX epoch seconds. */
  accessTokenExpiresAt: z.number().int(),
});
export type TenantAuthToken = z.infer<typeof tenantAuthTokenSchema>;

/**
 * Response body for `POST /me/auth/exchange` — LIFF receives both the JWT
 * and the resolved tenant identity (`tenantId` + `companyId` are also encoded
 * in the JWT, but surfacing them top-level lets the client route without
 * decoding the token).
 */
export const loginLiffResponseSchema = z.object({
  tenant: z.object({
    id: uuidSchema,
    companyId: companyIdSchema,
    companySlug: slugSchema,
  }),
  token: tenantAuthTokenSchema,
});
export type LoginLiffResponse = z.infer<typeof loginLiffResponseSchema>;
