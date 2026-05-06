import type { AnnouncementWire } from '@/queries/announcements';
import Link from 'next/link';

interface AnnouncementsTableProps {
  companySlug: string;
  items: readonly AnnouncementWire[];
}

/**
 * Server Component — renders a simple HTML table. Same approach as
 * tenants-table / contracts-table: no interactivity needed at the row
 * level (status chip + counters are read-only), so we skip the Client
 * boundary entirely. Click "ดู" to drill into detail.
 */
export function AnnouncementsTable({ companySlug, items }: AnnouncementsTableProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-md border bg-muted/40 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          ยังไม่มีประกาศ — คลิก "ประกาศใหม่" ด้านบนเพื่อส่งให้ผู้เช่าทุกคนผ่าน LINE
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-3 text-left font-medium">หัวข้อ</th>
            <th className="px-4 py-3 text-left font-medium">สถานะ</th>
            <th className="px-4 py-3 text-right font-medium">ส่งสำเร็จ / ทั้งหมด</th>
            <th className="px-4 py-3 text-left font-medium">เวลา</th>
            <th className="px-4 py-3 text-right font-medium" aria-label="actions" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((row) => {
            const total = row.deliveredCount + row.failedCount;
            return (
              <tr key={row.id} className="hover:bg-muted/30">
                <td className="px-4 py-3 align-top">
                  <p className="font-medium">{truncate(row.title, 60)}</p>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                    {truncate(row.body, 80)}
                  </p>
                </td>
                <td className="px-4 py-3 align-top">
                  <StatusChip status={row.status} />
                </td>
                <td className="px-4 py-3 text-right align-top tabular-nums">
                  <span className="font-medium">{row.deliveredCount}</span>
                  <span className="text-muted-foreground"> / {total}</span>
                  {row.failedCount > 0 ? (
                    <p className="text-xs text-red-600">ล้มเหลว {row.failedCount}</p>
                  ) : null}
                </td>
                <td className="px-4 py-3 align-top text-xs text-muted-foreground">
                  {formatBangkokDateTime(row.createdAt)}
                </td>
                <td className="px-4 py-3 text-right align-top">
                  <Link
                    href={`/c/${companySlug}/announcements/${row.id}`}
                    className="text-xs text-primary hover:underline"
                  >
                    ดู
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_LABEL: Record<AnnouncementWire['status'], string> = {
  draft: 'ร่าง',
  scheduled: 'ตั้งเวลาไว้',
  sending: 'กำลังส่ง',
  sent: 'ส่งสำเร็จ',
  failed: 'ล้มเหลว',
  cancelled: 'ยกเลิก',
};

const STATUS_CLASS: Record<AnnouncementWire['status'], string> = {
  draft: 'bg-slate-100 text-slate-700',
  scheduled: 'bg-sky-100 text-sky-700',
  sending: 'bg-amber-100 text-amber-800',
  sent: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-100 text-slate-500',
};

function StatusChip({ status }: { status: AnnouncementWire['status'] }) {
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * `2026-05-06T10:00:00Z` → `6 พ.ค. 2569 17:00`. Same pattern as the
 * dashboard's formatBangkokTime helper but with date prefix.
 */
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
