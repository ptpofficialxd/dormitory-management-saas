import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { announcementWireSchema } from '@/queries/announcements';
import { ChevronLeft, RefreshCw } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'รายละเอียดประกาศ',
};

interface AnnouncementDetailPageProps {
  params: Promise<{ companySlug: string; id: string }>;
}

/**
 * /c/[companySlug]/announcements/[id] — single announcement detail page
 * (Task #108).
 *
 * Server Component fetches the row each load — no client-side polling
 * yet. Admin reloads to watch delivery counters tick up while
 * status='sending'. The "รีเฟรช" link is a plain anchor that navigates
 * to the same URL, triggering Next's server fetch (no client JS needed).
 *
 * Layout: status header (chip + counters + when sent + by whom), then
 * the full title/body in a card. Phase 1 wishlist: per-tenant delivery
 * detail (who got it, who failed, retry button per failed recipient).
 */
export default async function AnnouncementDetailPage({ params }: AnnouncementDetailPageProps) {
  const { companySlug, id } = await params;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/announcements/${id}`);
  }

  let announcement: Awaited<ReturnType<typeof api.get<typeof announcementWireSchema>>>;
  try {
    announcement = await api.get(`/c/${companySlug}/announcements/${id}`, announcementWireSchema, {
      token,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.statusCode === 401 || err.code === 'UnauthorizedException') {
        redirect(`/login?next=/c/${companySlug}/announcements/${id}`);
      }
      if (err.statusCode === 404 || err.code === 'NotFoundException') {
        notFound();
      }
    }
    console.error('[announcements/detail] failed to load:', err);
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

  const total = announcement.deliveredCount + announcement.failedCount;
  const isInFlight = announcement.status === 'sending';

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/c/${companySlug}/announcements`}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          กลับไปรายการประกาศ
        </Link>
      </Button>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1.5">
              <StatusChip status={announcement.status} />
              <CardTitle className="text-lg leading-snug">{announcement.title}</CardTitle>
            </div>
            {isInFlight ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/c/${companySlug}/announcements/${id}`}>
                  <RefreshCw className="mr-1 h-3 w-3" />
                  รีเฟรช
                </Link>
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Stats strip */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="ส่งสำเร็จ" value={announcement.deliveredCount.toString()} tone="emerald" />
            <Stat
              label="ส่งไม่สำเร็จ"
              value={announcement.failedCount.toString()}
              tone={announcement.failedCount > 0 ? 'red' : 'slate'}
            />
            <Stat label="รวมทั้งหมด" value={total.toString()} tone="slate" />
          </div>

          {/* Body */}
          <div>
            <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">เนื้อหา</p>
            <p className="whitespace-pre-wrap break-words text-sm">{announcement.body}</p>
          </div>

          {/* Meta */}
          <dl className="grid grid-cols-1 gap-3 border-t pt-4 text-xs text-muted-foreground sm:grid-cols-2">
            <div>
              <dt className="font-medium">สร้างเมื่อ</dt>
              <dd className="tabular-nums">{formatBangkokDateTime(announcement.createdAt)}</dd>
            </div>
            <div>
              <dt className="font-medium">ส่งเสร็จเมื่อ</dt>
              <dd className="tabular-nums">
                {announcement.sentAt ? formatBangkokDateTime(announcement.sentAt) : '— ยังไม่เสร็จ'}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="font-medium">รหัสประกาศ</dt>
              <dd className="font-mono text-[10px]">{announcement.id}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'ร่าง',
  scheduled: 'ตั้งเวลาไว้',
  sending: 'กำลังส่ง',
  sent: 'ส่งสำเร็จ',
  failed: 'ล้มเหลว',
  cancelled: 'ยกเลิก',
};

const STATUS_CLASS: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  scheduled: 'bg-sky-100 text-sky-700',
  sending: 'bg-amber-100 text-amber-800',
  sent: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-100 text-slate-500',
};

function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status] ?? 'bg-slate-100 text-slate-700'}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

const TONE_BG: Record<'emerald' | 'red' | 'slate', string> = {
  emerald: 'bg-emerald-50 text-emerald-700',
  red: 'bg-red-50 text-red-700',
  slate: 'bg-muted text-foreground',
};

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'emerald' | 'red' | 'slate';
}) {
  return (
    <div className={`rounded-md p-3 ${TONE_BG[tone]}`}>
      <p className="text-xs uppercase tracking-wide opacity-80">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function formatBangkokDateTime(d: Date): string {
  return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}
