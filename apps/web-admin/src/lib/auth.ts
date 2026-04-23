import { type AdminJwtClaims, adminJwtClaimsSchema } from '@dorm/shared/zod';
import { jwtVerify } from 'jose';
import { env } from './env';

/**
 * JWT verification + claim extraction for the admin web.
 *
 * Tokens are minted by `apps/api`'s AuthService and stored as httpOnly cookies
 * (see `lib/cookies.ts`). Middleware verifies on every /c/[slug]/* request;
 * Server Components / Server Actions read the verified claims via this helper.
 *
 * `jose` (not `jsonwebtoken`) is used because middleware runs on Edge by default
 * and Edge has no Node `crypto`. `jose` ships a Web Crypto implementation.
 *
 * NOTE: this module deliberately does NOT import `'server-only'` because it is
 * consumed by both Server Components (server runtime) and middleware (Edge
 * runtime). Both are non-client environments, so leaking JWT_SECRET to the
 * browser is not a concern — but bundling `server-only` into the Edge chunk
 * has historically caused subtle errors. Keep the surface minimal.
 */

export type { AdminJwtClaims };

let secretBytes: Uint8Array | null = null;
function getSecretBytes(): Uint8Array {
  if (!secretBytes) secretBytes = new TextEncoder().encode(env.JWT_SECRET);
  return secretBytes;
}

/**
 * Verify an admin **access** token and return its claims, or `null` on any
 * verification failure (bad signature / expired / wrong typ / shape mismatch).
 *
 * Returns null instead of throwing so middleware and route guards can
 * branch with `if (!claims) redirect('/login')` cleanly without try/catch.
 */
export async function verifyAdminAccessToken(token: string): Promise<AdminJwtClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecretBytes(), {
      algorithms: ['HS256'],
    });
    const result = adminJwtClaimsSchema.safeParse(payload);
    if (!result.success) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[auth] JWT claim shape mismatch:', result.error.flatten());
      }
      return null;
    }
    // Refuse refresh-tokens replayed as access — apps/api enforces this on
    // the server too, but defence-in-depth on the client is cheap.
    if (result.data.typ !== 'access') {
      console.warn('[auth] JWT typ mismatch — refused token of type:', result.data.typ);
      return null;
    }
    return result.data;
  } catch (err) {
    // Expired / bad signature / malformed — all collapse to "not logged in".
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[auth] verify failed:', (err as Error).message);
    }
    return null;
  }
}
