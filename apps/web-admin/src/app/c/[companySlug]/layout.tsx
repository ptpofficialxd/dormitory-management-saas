import type { ReactNode } from 'react';

/**
 * Authenticated app shell — wraps every page under `/c/[companySlug]/*`.
 *
 * Task #58 (auth) will:
 *   - Read the `auth_token` cookie,
 *   - Call `verifyAdminToken` (server-side),
 *   - Redirect to /login on failure,
 *   - Compare claim.companySlug against `params.companySlug` and 403 on mismatch.
 *
 * Task #59 (shell) will replace this skeleton with a real sidebar + topbar
 * + breadcrumb. For the scaffold we keep the markup minimal so it renders
 * (and typechecks) without depending on auth state.
 */
export default async function CompanyLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ companySlug: string }>;
}) {
  const { companySlug } = await params;
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-background">
        <div className="container flex h-14 items-center justify-between">
          <span className="text-sm font-semibold tracking-tight">
            Dorm Admin <span className="text-muted-foreground">/ {companySlug}</span>
          </span>
          <span className="text-xs text-muted-foreground">รอ task #59 (app shell)</span>
        </div>
      </header>
      <main className="container flex-1 py-6">{children}</main>
    </div>
  );
}
