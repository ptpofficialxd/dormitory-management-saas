import 'server-only';
import { jwtVerify } from 'jose';
import { env } from './env';

/**
 * JWT verification + claim extraction for the admin web.
 *
 * The token is minted by `apps/api`'s AuthService and stored as an httpOnly
 * cookie named `auth_token`. Middleware verifies on every /c/[slug]/* request;
 * Server Components read the verified claims via `getAuthClaims()`.
 *
 * `jose` is used (not `jsonwebtoken`) because middleware runs on Edge by
 * default and Edge has no Node crypto — `jose` ships a Web Crypto impl.
 */

/** Claims minted by apps/api/src/modules/auth/auth.service.ts. */
export interface AdminClaims {
  /** User id (UUID). */
  sub: string;
  /** User email (denormalised into the token to avoid DB hit on every request). */
  email: string;
  /** Display name. */
  name: string;
  /** RBAC role — one of the 5 fixed roles per CLAUDE.md §3 #13. */
  role: 'company_owner' | 'property_manager' | 'staff' | 'tenant' | 'guardian';
  /** Company id (UUID) the user belongs to. */
  companyId: string;
  /** Slug for path-based routing — denormalised for nav links. */
  companySlug: string;
  /** JWT id (nonce — for revocation lookup). */
  jti: string;
  /** Issued-at, in seconds since epoch. */
  iat: number;
  /** Expires-at, in seconds since epoch. */
  exp: number;
}

/** Cookie name — keep consistent across middleware, login action, and logout. */
export const AUTH_COOKIE_NAME = 'auth_token';

/** Lazily-encoded secret — `jose` wants Uint8Array, not string. */
let secretBytes: Uint8Array | null = null;
function getSecretBytes(): Uint8Array {
  if (!secretBytes) secretBytes = new TextEncoder().encode(env.JWT_SECRET);
  return secretBytes;
}

/**
 * Verify a JWT and return its admin claims. Returns `null` (NOT throws) on
 * any verification failure — middleware and route guards branch on the null
 * to redirect → /login without leaking error details to the browser.
 */
export async function verifyAdminToken(token: string): Promise<AdminClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecretBytes(), {
      algorithms: ['HS256'],
    });
    // Narrow to AdminClaims — defensive checks since payload is `JWTPayload`.
    if (
      typeof payload.sub === 'string' &&
      typeof payload.email === 'string' &&
      typeof payload.name === 'string' &&
      typeof payload.role === 'string' &&
      typeof payload.companyId === 'string' &&
      typeof payload.companySlug === 'string' &&
      typeof payload.jti === 'string' &&
      typeof payload.iat === 'number' &&
      typeof payload.exp === 'number' &&
      isAdminRole(payload.role)
    ) {
      return {
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        role: payload.role,
        companyId: payload.companyId,
        companySlug: payload.companySlug,
        jti: payload.jti,
        iat: payload.iat,
        exp: payload.exp,
      };
    }
    console.warn('[auth] JWT payload shape mismatch:', payload);
    return null;
  } catch (err) {
    // Expired / bad signature / malformed — all collapse to "not logged in".
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[auth] verify failed:', (err as Error).message);
    }
    return null;
  }
}

function isAdminRole(role: string): role is AdminClaims['role'] {
  return (
    role === 'company_owner' ||
    role === 'property_manager' ||
    role === 'staff' ||
    role === 'tenant' ||
    role === 'guardian'
  );
}
