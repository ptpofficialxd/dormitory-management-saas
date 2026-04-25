import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { type ContractPage, contractPageSchema, contractStatusSchema } from '@/queries/contracts';
import { tenantPageSchema } from '@/queries/tenants';
import { ChevronRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AddContractButton } from './_components/add-contract-button';
import { ContractsTable } from './_components/contracts-table';

export const metadata: Metadata = {
  title: 'สัญญา',
};

interface ContractsPageProps {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{ cursor?: string; status?: string }>;
}

/**
 * /c/[companySlug]/contracts — list view.
 *
 * Server Component does the initial fetch. Pagination cursor-based;
 * status filter validated against the shared enum so a typo'd value
 * silently degrades to "all" instead of round-tripping a 400.
 *
 * The list shows tenant displayName + unit number inline (joined via
 * a parallel fetch on the same page). Phase 2 wishlist: API endpoint
 * returns the join eagerly so we don't N+1 here.
 *
 * The "เพิ่มสัญญา" button is RBAC-gated via AddContractButton (Client
 * Component using `<Can action="create" resource="contract">`).
 */
export default async function ContractsPage({ params, searchParams }: ContractsPageProps) {
  const { companySlug } = await params;
  const sp = await searchParams;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/contracts`);
  }

  const statusParam = sp.status ? contractStatusSchema.safeParse(sp.status) : null;
  const validStatus = statusParam?.success ? statusParam.data : null;

  const queryParts: string[] = [];
  if (sp.cursor) queryParts.push(`cursor=${encodeURIComponent(sp.cursor)}`);
  if (validStatus) queryParts.push(`status=${validStatus}`);
  const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

  let page: ContractPage;
  // Pull the tenant directory in parallel so we can show displayName next
  // to each contract row. Limit 100 — per the API max — keeps the join
  // cheap on a typical 40-room dorm. Bigger dorms get a Phase-2 sort+search.
  let tenantNameById: Record<string, string> = {};
  try {
    const [contractsPage, tenantsPage] = await Promise.all([
      api.get(`/c/${companySlug}/contracts${queryString}`, contractPageSchema, { token }),
      api.get(`/c/${companySlug}/tenants?limit=100`, tenantPageSchema, { token }),
    ]);
    page = contractsPage;
    tenantNameById = Object.fromEntries(tenantsPage.items.map((t) => [t.id, t.displayName]));
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.statusCode === 401 || err.code === 'UnauthorizedException')
    ) {
      redirect(`/login?next=/c/${companySlug}/contracts`);
    }
    console.error('[contracts/list] failed to load:', err);
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
          <h1 className="text-xl font-semibold tracking-tight">สัญญา</h1>
          <p className="text-sm text-muted-foreground">
            จัดการสัญญาเช่า ({page.items.length}
            {page.nextCursor ? '+ ' : ' '}รายการ
            {validStatus ? ` · กรอง: ${statusLabel(validStatus)}` : ''})
          </p>
        </div>
        <AddContractButton companySlug={companySlug} />
      </div>

      <StatusFilterBar companySlug={companySlug} active={validStatus} />

      <ContractsTable
        companySlug={companySlug}
        items={page.items}
        tenantNameById={tenantNameById}
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
  active: 'draft' | 'active' | 'ended' | 'terminated' | null;
}) {
  const chips = [
    { value: null, label: 'ทั้งหมด' },
    { value: 'draft' as const, label: 'ร่าง' },
    { value: 'active' as const, label: 'ใช้งาน' },
    { value: 'ended' as const, label: 'ครบกำหนด' },
    { value: 'terminated' as const, label: 'ยกเลิก' },
  ];
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {chips.map((chip) => {
        const isActive = chip.value === active;
        const href = chip.value
          ? `/c/${companySlug}/contracts?status=${chip.value}`
          : `/c/${companySlug}/contracts`;
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

function statusLabel(status: 'draft' | 'active' | 'ended' | 'terminated'): string {
  switch (status) {
    case 'draft':
      return 'ร่าง';
    case 'active':
      return 'ใช้งาน';
    case 'ended':
      return 'ครบกำหนด';
    case 'terminated':
      return 'ยกเลิก';
  }
}

function buildPageHref(
  companySlug: string,
  cursor: string,
  status: 'draft' | 'active' | 'ended' | 'terminated' | null,
): string {
  const parts = [`cursor=${encodeURIComponent(cursor)}`];
  if (status) parts.push(`status=${status}`);
  return `/c/${companySlug}/contracts?${parts.join('&')}`;
}
