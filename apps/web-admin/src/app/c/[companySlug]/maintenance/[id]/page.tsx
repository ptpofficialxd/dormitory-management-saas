import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { type MaintenanceRequestWire, maintenanceRequestWireSchema } from '@/queries/maintenance';
import { tenantPageSchema } from '@/queries/tenants';
import { unitPageSchema } from '@/queries/units';
import { type UserPublicWire, userPublicPageSchema } from '@/queries/users';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MaintenanceDetail } from '../_components/maintenance-detail';

export const metadata: Metadata = {
  title: 'รายละเอียดแจ้งซ่อม',
};

interface MaintenanceDetailPageProps {
  params: Promise<{ companySlug: string; id: string }>;
}

/**
 * /c/[companySlug]/maintenance/[id] — admin ticket detail.
 *
 * Server-side parallel fetch:
 *   - ticket detail
 *   - tenants directory (one row used: the reporter)
 *   - units directory (one row used: the unit)
 *   - users directory (assignee dropdown source — only fetched if user has
 *     `staff_user:read`; the API will 403 otherwise. We pre-pin to active
 *     status so disabled users don't pollute the dropdown)
 *
 * MaintenanceDetail is a Client Component because the assign / status /
 * resolution-note interactions need useTransition + form state.
 */
export default async function MaintenanceDetailPage({ params }: MaintenanceDetailPageProps) {
  const { companySlug, id } = await params;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/maintenance/${id}`);
  }

  let ticket: MaintenanceRequestWire;
  let tenantName = '—';
  let unitLabel = '—';
  let assignableUsers: UserPublicWire[] = [];
  try {
    const [t, tenants, units] = await Promise.all([
      api.get(`/c/${companySlug}/maintenance/${id}`, maintenanceRequestWireSchema, { token }),
      api.get(`/c/${companySlug}/tenants?limit=100`, tenantPageSchema, { token }),
      api.get(`/c/${companySlug}/units?limit=100`, unitPageSchema, { token }),
    ]);
    ticket = t;
    const tenant = tenants.items.find((x) => x.id === ticket.tenantId);
    if (tenant) tenantName = tenant.displayName;
    const unit = units.items.find((x) => x.id === ticket.unitId);
    if (unit) unitLabel = `ห้อง ${unit.unitNumber} (ชั้น ${unit.floor})`;

    // Users fetch is best-effort — staff role 403s here, the detail page
    // still renders without the assignee dropdown (read-only assignee).
    try {
      const usersPage = await api.get(
        `/c/${companySlug}/users?status=active&limit=100`,
        userPublicPageSchema,
        { token },
      );
      assignableUsers = usersPage.items;
    } catch (uErr) {
      if (
        uErr instanceof ApiError &&
        (uErr.statusCode === 403 || uErr.code === 'ForbiddenException')
      ) {
        // Staff role doesn't have staff_user:read — that's fine, leave
        // assignableUsers empty + the detail UI hides the dropdown.
        assignableUsers = [];
      } else {
        throw uErr;
      }
    }
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.statusCode === 401 || err.code === 'UnauthorizedException')
    ) {
      redirect(`/login?next=/c/${companySlug}/maintenance/${id}`);
    }
    if (err instanceof ApiError && err.statusCode === 404) {
      return (
        <div className="mx-auto max-w-xl space-y-3">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href={`/c/${companySlug}/maintenance`}>
              <ChevronLeft className="mr-1 h-4 w-4" />
              กลับไปรายการแจ้งซ่อม
            </Link>
          </Button>
          <Card>
            <CardHeader>
              <CardTitle>ไม่พบรายการแจ้งซ่อม</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                อาจถูกลบหรือ URL ไม่ถูกต้อง — กรุณากลับไปที่รายการ
              </p>
            </CardContent>
          </Card>
        </div>
      );
    }
    console.error('[maintenance/detail] failed to load:', err);
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
    <div className="mx-auto max-w-3xl space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/c/${companySlug}/maintenance`}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          กลับไปรายการแจ้งซ่อม
        </Link>
      </Button>

      <MaintenanceDetail
        companySlug={companySlug}
        ticket={ticket}
        tenantName={tenantName}
        unitLabel={unitLabel}
        assignableUsers={assignableUsers.map((u) => ({
          id: u.id,
          displayName: u.displayName,
          email: u.email,
        }))}
      />
    </div>
  );
}
