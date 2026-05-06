import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { type AuditLogPage, auditLogPageSchema } from '@/queries/audit-log';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuditLogTable } from './_components/audit-log-table';

export const metadata: Metadata = {
  title: 'บันทึกกิจกรรม',
};

interface AuditLogIndexPageProps {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{
    cursor?: string;
    action?: string;
    resource?: string;
  }>;
}

/**
 * /c/[companySlug]/audit-log — read-only audit trail (Task #120 / SAAS-003).
 *
 * Standalone nav-level page (not under settings) so Phase 1 can extend it
 * with CSV export, retention rules, retention banners, etc. without IA
 * churn. RBAC: `audit_log:read` (owner + property_manager). Staff see no
 * nav item; if they URL-trick their way here the API returns 403 and we
 * render the same error Card as other RBAC blocks.
 *
 * Filters in v1: free-text `action` + `resource` (URL params, not Zod-
 * validated client-side — server is the canonical validator). Date range
 * + actor picker land in Phase 1 once we have a date-picker component
 * and a user-search endpoint.
 */
export default async function AuditLogIndexPage({ params, searchParams }: AuditLogIndexPageProps) {
  const { companySlug } = await params;
  const sp = await searchParams;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/audit-log`);
  }

  const queryParts: string[] = [];
  if (sp.cursor) queryParts.push(`cursor=${encodeURIComponent(sp.cursor)}`);
  if (sp.action) queryParts.push(`action=${encodeURIComponent(sp.action)}`);
  if (sp.resource) queryParts.push(`resource=${encodeURIComponent(sp.resource)}`);
  const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

  let page: AuditLogPage;
  try {
    page = await api.get(`/c/${companySlug}/audit-logs${queryString}`, auditLogPageSchema, {
      token,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.statusCode === 401 || err.code === 'UnauthorizedException') {
        redirect(`/login?next=/c/${companySlug}/audit-log`);
      }
      if (err.statusCode === 403 || err.code === 'ForbiddenException') {
        return (
          <Card>
            <CardHeader>
              <CardTitle>คุณไม่มีสิทธิ์ดูบันทึกกิจกรรม</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                เฉพาะเจ้าของหอ + ผู้จัดการเท่านั้นที่เข้าถึง audit log ได้ — ติดต่อแอดมินของบริษัทหากต้องการสิทธิ์เพิ่ม
              </p>
            </CardContent>
          </Card>
        );
      }
    }
    console.error('[audit-log/list] failed to load:', err);
    return (
      <Card>
        <CardHeader>
          <CardTitle>โหลดบันทึกกิจกรรมไม่สำเร็จ</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            กรุณาลองรีเฟรชหน้านี้ หรือติดต่อทีมเทคนิคหากปัญหายังเกิดขึ้น
          </p>
        </CardContent>
      </Card>
    );
  }

  const hasFilters = Boolean(sp.action || sp.resource);
  const isFirstPage = !sp.cursor;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">บันทึกกิจกรรม</h1>
        <p className="text-sm text-muted-foreground">
          ประวัติการเปลี่ยนแปลงในระบบ — append-only ไม่สามารถลบหรือแก้ได้ (PDPA / audit trail)
          {' · '}
          {page.items.length}
          {page.nextCursor ? '+ ' : ' '}รายการ
          {hasFilters ? ' · มีตัวกรอง' : ''}
        </p>
      </div>

      <FilterBar companySlug={companySlug} action={sp.action} resource={sp.resource} />

      <AuditLogTable items={page.items} />

      <div className="flex items-center justify-between gap-2">
        {!isFirstPage ? (
          <Link
            href={buildPageHref(companySlug, undefined, sp.action, sp.resource)}
            className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="mr-1 h-3 w-3" />
            กลับไปหน้าแรก
          </Link>
        ) : (
          <span />
        )}
        {page.nextCursor ? (
          <Link
            href={buildPageHref(companySlug, page.nextCursor, sp.action, sp.resource)}
            className="inline-flex items-center rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            หน้าถัดไป
            <ChevronRight className="ml-1 h-3 w-3" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Filter bar — free-text inputs for action + resource. Server-rendered as
 * a `<form method="get">` so reload semantics + back-button work without JS.
 * Phase 1: replace with rhf-driven client form once we add date-range picker.
 */
function FilterBar({
  companySlug,
  action,
  resource,
}: {
  companySlug: string;
  action: string | undefined;
  resource: string | undefined;
}) {
  return (
    <form
      method="get"
      action={`/c/${companySlug}/audit-log`}
      className="flex flex-wrap items-end gap-2 rounded-md border bg-card p-3 text-xs"
    >
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Action</span>
        <input
          name="action"
          defaultValue={action ?? ''}
          placeholder="เช่น signup.success"
          className="rounded-md border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          maxLength={64}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Resource</span>
        <input
          name="resource"
          defaultValue={resource ?? ''}
          placeholder="เช่น company / invoice"
          className="rounded-md border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          maxLength={64}
        />
      </label>
      <div className="flex gap-2 self-end">
        <button
          type="submit"
          className="rounded-md border border-primary bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
        >
          กรอง
        </button>
        {action || resource ? (
          <Link
            href={`/c/${companySlug}/audit-log`}
            className="rounded-md border bg-background px-3 py-1.5 text-xs hover:bg-muted"
          >
            ล้างตัวกรอง
          </Link>
        ) : null}
      </div>
    </form>
  );
}

function buildPageHref(
  companySlug: string,
  cursor: string | undefined,
  action: string | undefined,
  resource: string | undefined,
): string {
  const parts: string[] = [];
  if (cursor) parts.push(`cursor=${encodeURIComponent(cursor)}`);
  if (action) parts.push(`action=${encodeURIComponent(action)}`);
  if (resource) parts.push(`resource=${encodeURIComponent(resource)}`);
  return parts.length === 0
    ? `/c/${companySlug}/audit-log`
    : `/c/${companySlug}/audit-log?${parts.join('&')}`;
}
