import { verifyAdminAccessToken } from '@/lib/auth';
import { ACCESS_COOKIE_NAME } from '@/lib/auth-constants';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Auth gate for `/c/[companySlug]/*`.
 *
 * Runs on every matching request (matcher excludes static assets, /login,
 * and /api/health). Two responsibilities:
 *
 *   1. **Authentication** — verify the access token cookie (JWT, HS256).
 *      Missing/invalid → 302 to /login?next=<original path>.
 *
 *   2. **Tenant isolation** — claims.companySlug MUST match the path's
 *      [companySlug] param. A mismatch is treated as a stale bookmark
 *      (e.g. user changed company) and is silently rewritten to the
 *      user's own company dashboard. We do NOT 403 here — that would
 *      surface as a confusing error page; the layout already calls
 *      verifyAdminAccessToken again as defence in depth.
 *
 * Refresh-token rotation is intentionally NOT done here — it would require
 * a synchronous fetch from the Edge runtime to /auth/refresh on every page
 * load. Instead, the access token expires from its own cookie `expires` and
 * the user re-logs in. Refresh rotation will land in a follow-up once we
 * have a server-side helper that can mint+set inside a Route Handler.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Only gate /c/[slug]/* — matcher already excludes /login + Next internals.
  const slugMatch = pathname.match(/^\/c\/([^/]+)/);
  if (!slugMatch) return NextResponse.next();
  const requestedSlug = slugMatch[1];

  const accessToken = req.cookies.get(ACCESS_COOKIE_NAME)?.value;
  const claims = accessToken ? await verifyAdminAccessToken(accessToken) : null;

  if (!claims) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (claims.companySlug !== requestedSlug) {
    const url = req.nextUrl.clone();
    url.pathname = `/c/${claims.companySlug}/dashboard`;
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Run on every page that needs auth. /login, /signup + Next internals are
   * excluded via the negative-lookahead pattern — recommended Next 15 form.
   * (`signup` covers both `/signup` and `/signup/welcome` post-signup landing.)
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|login|signup|api/health).*)'],
};
