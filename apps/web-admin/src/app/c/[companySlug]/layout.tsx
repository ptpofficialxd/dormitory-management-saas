import { AdminShell } from '@/components/shell/admin-shell';
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
 * Visual chrome (sidebar / topbar / breadcrumb / mobile drawer) lives in
 * `<AdminShell>` (Client Component). We pass `<LogoutButton />` (a Server
 * Component) in via the `logoutSlot` prop so its `<form action={serverAction}>`
 * keeps progressive enhancement — Client Components can't import Server
 * Components, but they can render them when handed in as ReactNode.
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
    <AdminShell companySlug={companySlug} email={claims.email} logoutSlot={<LogoutButton />}>
      {children}
    </AdminShell>
  );
}
