import { AdminShell } from '@/components/shell/admin-shell';
import { verifyAdminAccessToken } from '@/lib/auth';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { RbacProvider } from '@/lib/rbac';
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

  return (
    <RbacProvider roles={claims.roles}>
      <AdminShell companySlug={companySlug} email={claims.email} logoutSlot={<LogoutButton />}>
        {children}
      </AdminShell>
    </RbacProvider>
  );
}
