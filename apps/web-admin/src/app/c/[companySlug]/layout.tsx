import { AdminShell } from '@/components/shell/admin-shell';
import { ApiError, api } from '@/lib/api';
import { verifyAdminAccessToken } from '@/lib/auth';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { RbacProvider } from '@/lib/rbac';
import { type MeResponse, meResponseSchema } from '@dorm/shared/zod';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { LogoutButton } from './_components/logout-button';
import { TrialBanner } from './_components/trial-banner';

/**
 * Authenticated app shell — wraps every page under `/c/[companySlug]/*`.
 *
 * Defence in depth: middleware also gates this path, but the layout reads
 * claims a SECOND time so:
 *   1. Children can render personalised content (email, role) without
 *      another fetch round-trip,
 *   2. If middleware ever has a hole (matcher typo, etc.) we still bounce
 *      unauthenticated users to /login,
 *   3. Local dev sometimes runs without middleware (route.ts files etc.) —
 *      this guard keeps things consistent.
 *
 * Composition:
 *   - `<RbacProvider>` (Client) wraps EVERYTHING below so any descendant
 *     can call `useRole()` / `<Can>`. Roles come from the verified JWT —
 *     never trust a user-supplied role.
 *   - `<AdminShell>` (Client) renders sidebar + topbar + breadcrumb. It
 *     uses `useRole()` to filter sidebar items by permission.
 *   - `<LogoutButton />` (Server) is passed as `logoutSlot` so its
 *     `<form action={serverAction}>` keeps progressive enhancement.
 */
export default async function CompanyLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ companySlug: string }>;
}) {
  const { companySlug } = await params;

  const token = await getAccessTokenFromCookie();
  const claims = token ? await verifyAdminAccessToken(token) : null;
  if (!claims) {
    redirect(`/login?next=/c/${companySlug}`);
  }
  if (claims.companySlug !== companySlug) {
    redirect(`/c/${claims.companySlug}/dashboard`);
  }

  // Fetch /me to drive the trial banner + plan badge. Failures degrade
  // gracefully — if /me is down the user still sees pages, just without
  // the trial-state chrome. Ship-level resilience > shell perfection.
  let me: MeResponse | null = null;
  try {
    me = await api.get(`/c/${companySlug}/me`, meResponseSchema, { token: token ?? undefined });
  } catch (err) {
    // 401 = stale cookie; force re-login. Anything else: log + render
    // the shell without entitlements rather than blocking page rendering.
    if (
      err instanceof ApiError &&
      (err.statusCode === 401 || err.code === 'UnauthorizedException')
    ) {
      redirect(`/login?next=/c/${companySlug}`);
    }
    console.error('[layout/c] /me fetch failed (non-blocking):', err);
  }

  return (
    <RbacProvider roles={claims.roles}>
      <AdminShell
        companySlug={companySlug}
        email={claims.email}
        plan={me?.entitlements.plan ?? null}
        logoutSlot={<LogoutButton />}
        trialBannerSlot={me ? <TrialBanner entitlements={me.entitlements} /> : null}
      >
        {children}
      </AdminShell>
    </RbacProvider>
  );
}
