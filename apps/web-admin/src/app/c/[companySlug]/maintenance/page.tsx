import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import {
  type MaintenanceRequestPage,
  maintenanceRequestPageSchema,
  maintenanceStatusSchema,
} from '@/queries/maintenance';
import { tenantPageSchema } from '@/queries/tenants';
import { unitPageSchema } from '@/queries/units';
import { ChevronRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MaintenanceTable } from './_components/maintenance-table';

export const metadata: Metadata = {
  title: 'แจ้งซ่อม',
};

interface MaintenancePageProps {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{ cursor?: string; status?: string }>;
}

/**
 * /c/[companySlug]/maintenance — admin ticket list.
 *
 * Same pattern as /contracts and /invoices: server-side parallel fetch +
 * status filter chips + cursor pagination. Tenant + unit directories
 * pulled in parallel so the table can show "ห้อง 305 — สมชาย" inline
 * without N+1 round-trips.
 *
 * Phase 2 wishlist: API endpoint that returns tickets joined with tenant +
 * unit so we don't ship 3 lists across the wire on every page load.
 */
export default async function MaintenancePage({ params, searchParams }: MaintenancePageProps) {
  const { companySlug } = await params;
  const sp = await searchParams;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/maintenance`);
  }

  const statusParam = sp.status ? maintenanceStatusSchema.safeParse(sp.status) : null;
  const validStatus = statusParam?.success ? statusParam.data : null;

  const queryParts: string[] = [];
  if (sp.cursor) queryParts.push(`cursor=${encodeURIComponent(sp.cursor)}`);
  if (validStatus) queryParts.push(`status=${validStatus}`);
  const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

  let page: MaintenanceRequestPage;
  let tenantNameById: Record<string, string> = {};
  let unitLabelById: Record<string, string> = {};
  try {
    const [ticketsPage, tenantsPage, unitsPage] = await Promise.all([
      api.get(`/c/${companySlug}/maintenance${queryString}`, maintenanceRequestPageSchema, {
        token,
      }),
      api.get(`/c/${companySlug}/tenants?limit=100`, tenantPageSchema, { token }),
      api.get(`/c/${companySlug}/units?limit=100`, unitPageSchema, { token }),
    ]);
    page = ticketsPage;
    tenantNameById = Object.fromEntries(tenantsPage.items.map((t) => [t.id, t.displayName]));
    unitLabelById = Object.fromEntries(
      unitsPage.items.map((u) => [u.id, `ห้อง ${u.unitNumber} (ชั้น ${u.floor})`]),
    );
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.statusCode === 401 || err.code === 'UnauthorizedException')
    ) {
      redirect(`/login?next=/c/${companySlug}/maintenance`);
    }
    console.error('[maintenance/list] failed to load:', err);
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
      <div>
        <h1 className="text-xl font-semibold tracking-tight">แจ้งซ่อม</h1>
        <p className="text-sm text-muted-foreground">
          ผู้เช่าแจ้งปัญหาผ่าน LIFF — staff รับเรื่อง อัปเดตสถานะ และปิดงาน ({page.items.length}
          {page.nextCursor ? '+ ' : ' '}รายการ
          {validStatus ? ` · กรอง: ${statusLabel(validStatus)}` : ''})
        </p>
      </div>

      <StatusFilterBar companySlug={companySlug} active={validStatus} />

      <MaintenanceTable
        companySlug={companySlug}
        items={page.items}
        tenantNameById={tenantNameById}
        unitLabelById={unitLabelById}
      />

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

function StatusFilterBar({
  companySlug,
  active,
}: {
  companySlug: string;
  active: 'open' | 'in_progress' | 'resolved' | 'closed' | 'cancelled' | null;
}) {
  const chips = [
    { value: null, label: 'ทั้งหมด' },
    { value: 'open' as const, label: 'รอรับเรื่อง' },
    { value: 'in_progress' as const, label: 'กำลังดำเนินการ' },
    { value: 'resolved' as const, label: 'ซ่อมแล้ว' },
    { value: 'closed' as const, label: 'ปิดงาน' },
    { value: 'cancelled' as const, label: 'ตีตก' },
  ];
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {chips.map((chip) => {
        const isActive = chip.value === active;
        const href = chip.value
          ? `/c/${companySlug}/maintenance?status=${chip.value}`
          : `/c/${companySlug}/maintenance`;
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

function statusLabel(status: 'open' | 'in_progress' | 'resolved' | 'closed' | 'cancelled'): string {
  switch (status) {
    case 'open':
      return 'รอรับเรื่อง';
    case 'in_progress':
      return 'กำลังดำเนินการ';
    case 'resolved':
      return 'ซ่อมแล้ว';
    case 'closed':
      return 'ปิดงาน';
    case 'cancelled':
      return 'ตีตก';
  }
}

function buildPageHref(
  companySlug: string,
  cursor: string,
  status: 'open' | 'in_progress' | 'resolved' | 'closed' | 'cancelled' | null,
): string {
  const parts = [`cursor=${encodeURIComponent(cursor)}`];
  if (status) parts.push(`status=${status}`);
  return `/c/${companySlug}/maintenance?${parts.join('&')}`;
}
