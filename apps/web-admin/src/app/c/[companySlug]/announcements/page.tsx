import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import {
  type AnnouncementPage,
  announcementPageSchema,
  announcementStatusSchema,
} from '@/queries/announcements';
import { ChevronRight, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AnnouncementsTable } from './_components/announcements-table';

export const metadata: Metadata = {
  title: 'ประกาศ',
};

interface AnnouncementsPageProps {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{ cursor?: string; status?: string }>;
}

/**
 * /c/[companySlug]/announcements — admin broadcast list (Task #108).
 *
 * Same shell as /maintenance and /contracts: Server Component does the
 * initial fetch with the user's JWT (read from the httpOnly cookie),
 * status filter passes through as `?status=…` validated against the
 * shared enum, cursor pagination via `<Link>` (no client state).
 *
 * v1 list shows: title (truncated), status chip, delivered/total, when
 * sent, who sent. Reload page to refresh delivery counters (workers may
 * still be in flight when status='sending'). Phase 1 wishlist: revalidate
 * automatically every 15s while any row is in 'sending' state.
 */
export default async function AnnouncementsPage({ params, searchParams }: AnnouncementsPageProps) {
  const { companySlug } = await params;
  const sp = await searchParams;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/announcements`);
  }

  const statusParam = sp.status ? announcementStatusSchema.safeParse(sp.status) : null;
  const validStatus = statusParam?.success ? statusParam.data : null;

  const queryParts: string[] = [];
  if (sp.cursor) queryParts.push(`cursor=${encodeURIComponent(sp.cursor)}`);
  if (validStatus) queryParts.push(`status=${validStatus}`);
  const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

  let page: AnnouncementPage;
  try {
    page = await api.get(`/c/${companySlug}/announcements${queryString}`, announcementPageSchema, {
      token,
    });
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.statusCode === 401 || err.code === 'UnauthorizedException')
    ) {
      redirect(`/login?next=/c/${companySlug}/announcements`);
    }
    console.error('[announcements/list] failed to load:', err);
    return (
      <Card>
        <CardHeader>
          <CardTitle>โหลดประกาศไม่สำเร็จ</CardTitle>
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
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">ประกาศ</h1>
          <p className="text-sm text-muted-foreground">
            ส่งข้อความถึงผู้เช่าทุกคนผ่าน LINE OA — ผู้เช่าที่ผูกบัญชีแล้วจะได้รับทันที ({page.items.length}
            {page.nextCursor ? '+ ' : ' '}รายการ
            {validStatus ? ` · กรอง: ${statusLabel(validStatus)}` : ''})
          </p>
        </div>
        <Button asChild size="sm">
          <Link href={`/c/${companySlug}/announcements/new`}>
            <Plus className="mr-1 h-4 w-4" />
            ประกาศใหม่
          </Link>
        </Button>
      </div>

      <StatusFilterBar companySlug={companySlug} active={validStatus} />

      <AnnouncementsTable companySlug={companySlug} items={page.items} />

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
 * Status filter chips — Server Component, just renders <Link>s. Cursor
 * resets on filter change to avoid the cursor pointing at a row outside
 * the new filter window. v1 only writes `sending` / `sent` / `failed` —
 * `draft` / `scheduled` / `cancelled` chips reserved for Phase 1 but
 * harmless to render now (just no rows).
 */
function StatusFilterBar({
  companySlug,
  active,
}: {
  companySlug: string;
  active: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled' | null;
}) {
  const chips = [
    { value: null, label: 'ทั้งหมด' },
    { value: 'sending' as const, label: 'กำลังส่ง' },
    { value: 'sent' as const, label: 'ส่งสำเร็จ' },
    { value: 'failed' as const, label: 'ส่งไม่สำเร็จ' },
  ];
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {chips.map((chip) => {
        const isActive = chip.value === active;
        const href = chip.value
          ? `/c/${companySlug}/announcements?status=${chip.value}`
          : `/c/${companySlug}/announcements`;
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

function statusLabel(
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled',
): string {
  switch (status) {
    case 'draft':
      return 'ร่าง';
    case 'scheduled':
      return 'ตั้งเวลาไว้';
    case 'sending':
      return 'กำลังส่ง';
    case 'sent':
      return 'ส่งสำเร็จ';
    case 'failed':
      return 'ส่งไม่สำเร็จ';
    case 'cancelled':
      return 'ยกเลิก';
  }
}

function buildPageHref(
  companySlug: string,
  cursor: string,
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled' | null,
): string {
  const parts = [`cursor=${encodeURIComponent(cursor)}`];
  if (status) parts.push(`status=${status}`);
  return `/c/${companySlug}/announcements?${parts.join('&')}`;
}
