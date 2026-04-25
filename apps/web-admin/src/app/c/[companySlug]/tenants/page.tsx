import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { type TenantPage, tenantPageSchema, tenantStatusSchema } from '@/queries/tenants';
import { ChevronRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AddTenantButton } from './_components/add-tenant-button';
import { TenantsTable } from './_components/tenants-table';

export const metadata: Metadata = {
  title: 'ผู้เช่า',
};

interface TenantsPageProps {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{ cursor?: string; status?: string }>;
}

/**
 * /c/[companySlug]/tenants — list view.
 *
 * Server Component does the initial fetch with the user's JWT (read from
 * the httpOnly cookie). Pagination is cursor-based; status filter passes
 * through as `?status=active|moved_out|blocked` directly to the API
 * (validated client-side against the shared enum so a typo'd filter
 * value short-circuits to "no filter" instead of a 400 round-trip).
 *
 * The "Add Tenant" button is gated by RBAC via the AddTenantButton Client
 * Component — owner / property_manager / staff can create per the matrix.
 * The API enforces the same via @Perm('create','tenant_user'); the gate
 * here is purely UX.
 */
export default async function TenantsPage({ params, searchParams }: TenantsPageProps) {
  const { companySlug } = await params;
  const sp = await searchParams;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/tenants`);
  }

  // Validate the status filter against the shared enum BEFORE forwarding.
  // An invalid value gets dropped silently — the user just sees "all".
  const statusParam = sp.status ? tenantStatusSchema.safeParse(sp.status) : null;
  const validStatus = statusParam?.success ? statusParam.data : null;

  const queryParts: string[] = [];
  if (sp.cursor) queryParts.push(`cursor=${encodeURIComponent(sp.cursor)}`);
  if (validStatus) queryParts.push(`status=${validStatus}`);
  const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

  let page: TenantPage;
  try {
    page = await api.get(`/c/${companySlug}/tenants${queryString}`, tenantPageSchema, {
      token,
    });
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.statusCode === 401 || err.code === 'UnauthorizedException')
    ) {
      redirect(`/login?next=/c/${companySlug}/tenants`);
    }
    console.error('[tenants/list] failed to load:', err);
    return (
      <Card>
        <CardHeader>
          <CardTitle>โหลดข้อมูลไม่สำเร็จ</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            กรุณาลองรีเฟรชหน้านี้ หรือติดต่อทีมเทคนิคหากปัญหายังเกิดขึ้น
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">ผู้เช่า</h1>
          <p className="text-sm text-muted-foreground">
            จัดการผู้เช่าของหอพัก ({page.items.length}
            {page.nextCursor ? '+ ' : ' '}รายการ
            {validStatus ? ` · กรอง: ${statusLabel(validStatus)}` : ''})
          </p>
        </div>
        <AddTenantButton companySlug={companySlug} />
      </div>

      <StatusFilterBar companySlug={companySlug} active={validStatus} />

      <TenantsTable companySlug={companySlug} items={page.items} />

      {page.nextCursor ? (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link href={buildPageHref(companySlug, page.nextCursor, validStatus)}>
              หน้าถัดไป
              <ChevronRight className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Status filter chips — Server Component, just renders <Link>s. Active chip
 * gets a darker bg. Click resets cursor (different filter = new page space)
 * to avoid the cursor pointing at a row outside the new filter window.
 */
function StatusFilterBar({
  companySlug,
  active,
}: {
  companySlug: string;
  active: 'active' | 'moved_out' | 'blocked' | null;
}) {
  const chips = [
    { value: null, label: 'ทั้งหมด' },
    { value: 'active' as const, label: 'พักอยู่' },
    { value: 'moved_out' as const, label: 'ย้ายออก' },
    { value: 'blocked' as const, label: 'ระงับ' },
  ];
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {chips.map((chip) => {
        const isActive = chip.value === active;
        const href = chip.value
          ? `/c/${companySlug}/tenants?status=${chip.value}`
          : `/c/${companySlug}/tenants`;
        return (
          <Link
            key={chip.label}
            href={href}
            className={
              isActive
                ? 'rounded-full border border-primary bg-primary px-3 py-1 font-medium text-primary-foreground'
                : 'rounded-full border bg-background px-3 py-1 text-muted-foreground hover:bg-muted'
            }
          >
            {chip.label}
          </Link>
        );
      })}
    </div>
  );
}

function statusLabel(status: 'active' | 'moved_out' | 'blocked'): string {
  switch (status) {
    case 'active':
      return 'พักอยู่';
    case 'moved_out':
      return 'ย้ายออก';
    case 'blocked':
      return 'ระงับ';
  }
}

function buildPageHref(
  companySlug: string,
  cursor: string,
  status: 'active' | 'moved_out' | 'blocked' | null,
): string {
  const parts = [`cursor=${encodeURIComponent(cursor)}`];
  if (status) parts.push(`status=${status}`);
  return `/c/${companySlug}/tenants?${parts.join('&')}`;
}
