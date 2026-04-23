import { verifyAdminAccessToken } from '@/lib/auth';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { LogoutButton } from './_components/logout-button';

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
 * Task #59 will replace the bare `<header>` with a real sidebar + topbar.
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

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-background">
        <div className="container flex h-14 items-center justify-between gap-4">
          <span className="text-sm font-semibold tracking-tight">
            Dorm Admin <span className="text-muted-foreground">/ {companySlug}</span>
          </span>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline" title={claims.email}>
              {claims.email}
            </span>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="container flex-1 py-6">{children}</main>
    </div>
  );
}
