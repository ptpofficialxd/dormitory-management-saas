import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * Middleware — auth gate for `/c/[companySlug]/*`.
 *
 * SCAFFOLD STAGE: pass-through. Task #58 will replace the body with:
 *   1. Skip /_next, /api, static assets,
 *   2. Read `auth_token` cookie,
 *   3. `verifyAdminToken` (jose works on Edge),
 *   4. On null → 302 to /login?next=<original>,
 *   5. On valid claims → assert `params.companySlug` matches `claim.companySlug`,
 *      otherwise 403 (cross-company nav attempt).
 *
 * Kept as a no-op now so:
 *   - The route works in dev without env vars set,
 *   - We exercise Next's middleware compile path during `next build` early,
 *   - The matcher is fixed in one place once auth lands.
 */
export function middleware(_req: NextRequest) {
  return NextResponse.next();
}

export const config = {
  /**
   * Run on every page that needs auth. /login and Next internals are excluded
   * via the negative-lookahead pattern — this is the recommended Next 15 form.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|login|api/health).*)'],
};
