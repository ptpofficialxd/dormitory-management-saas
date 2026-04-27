import type { MaintenanceRequestWire } from '@/queries/maintenance';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

/**
 * MaintenanceTable — admin list view (Server Component, no 'use client').
 *
 * Static table; row click navigates to detail page (no inline edit).
 * Mirrors the contracts-table / invoices-table pattern.
 *
 * Mobile: each row collapses to a card via responsive hidden/block classes
 * — same approach as ReadingsGrid (Task #82).
 */

const STATUS_BADGE: Record<MaintenanceRequestWire['status'], { label: string; className: string }> =
  {
    open: {
      label: 'รอรับเรื่อง',
      className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    },
    in_progress: {
      label: 'กำลังดำเนินการ',
      className: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    },
    resolved: {
      label: 'ซ่อมแล้ว',
      className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    closed: {
      label: 'ปิดงาน',
      className: 'bg-muted text-muted-foreground',
    },
    cancelled: {
      label: 'ตีตก',
      className: 'bg-destructive/15 text-destructive',
    },
  };

const PRIORITY_BADGE: Record<
  MaintenanceRequestWire['priority'],
  { label: string; className: string }
> = {
  low: { label: 'ต่ำ', className: 'text-muted-foreground' },
  normal: { label: 'ปกติ', className: 'text-foreground' },
  high: { label: 'สูง', className: 'text-orange-600 font-medium' },
  urgent: { label: 'ด่วน', className: 'text-destructive font-semibold' },
};

const CATEGORY_LABEL: Record<MaintenanceRequestWire['category'], string> = {
  plumbing: 'ประปา',
  electrical: 'ไฟฟ้า',
  aircon: 'แอร์',
  appliance: 'เครื่องใช้',
  furniture: 'เฟอร์นิเจอร์',
  structural: 'โครงสร้าง',
  internet: 'อินเทอร์เน็ต',
  other: 'อื่น ๆ',
};

interface MaintenanceTableProps {
  companySlug: string;
  items: MaintenanceRequestWire[];
  tenantNameById: Record<string, string>;
  unitLabelById: Record<string, string>;
}

export function MaintenanceTable({
  companySlug,
  items,
  tenantNameById,
  unitLabelById,
}: MaintenanceTableProps) {
  if (items.length === 0) {
    return (
      <p className="rounded-md border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
        ยังไม่มีรายการแจ้งซ่อมในขอบเขตที่เลือก
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border">
      {/* Desktop table */}
      <table className="hidden w-full border-collapse text-sm md:table">
        <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">เรื่อง</th>
            <th className="px-3 py-2 text-left font-medium">ห้อง / ผู้แจ้ง</th>
            <th className="px-3 py-2 text-left font-medium">หมวด</th>
            <th className="px-3 py-2 text-left font-medium">ความเร่งด่วน</th>
            <th className="px-3 py-2 text-left font-medium">สถานะ</th>
            <th className="px-3 py-2 text-right font-medium">วันที่แจ้ง</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {items.map((ticket) => {
            const status = STATUS_BADGE[ticket.status];
            const priority = PRIORITY_BADGE[ticket.priority];
            return (
              <tr key={ticket.id} className="border-t hover:bg-muted/20">
                <td className="px-3 py-2">
                  <Link
                    href={`/c/${companySlug}/maintenance/${ticket.id}`}
                    className="font-medium hover:underline"
                  >
                    {ticket.title}
                  </Link>
                  {ticket.photoR2Keys.length > 0 ? (
                    <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                      📷 {ticket.photoR2Keys.length}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-xs">
                  <div>{unitLabelById[ticket.unitId] ?? '—'}</div>
                  <div className="text-muted-foreground">
                    {tenantNameById[ticket.tenantId] ?? '—'}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">{CATEGORY_LABEL[ticket.category]}</td>
                <td className={`px-3 py-2 text-xs ${priority.className}`}>{priority.label}</td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${status.className}`}
                  >
                    {status.label}
                  </span>
                </td>
                <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                  {formatDateTh(ticket.createdAt)}
                </td>
                <td className="px-3 py-2 text-right">
                  <Link
                    href={`/c/${companySlug}/maintenance/${ticket.id}`}
                    aria-label="ดูรายละเอียด"
                    className="inline-flex items-center text-muted-foreground hover:text-foreground"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Mobile cards */}
      <div className="divide-y md:hidden">
        {items.map((ticket) => {
          const status = STATUS_BADGE[ticket.status];
          const priority = PRIORITY_BADGE[ticket.priority];
          return (
            <Link
              key={ticket.id}
              href={`/c/${companySlug}/maintenance/${ticket.id}`}
              className="block space-y-1.5 p-3 hover:bg-muted/20"
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-medium">{ticket.title}</p>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${status.className}`}
                >
                  {status.label}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {unitLabelById[ticket.unitId] ?? '—'} · {tenantNameById[ticket.tenantId] ?? '—'}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>{CATEGORY_LABEL[ticket.category]}</span>
                <span>·</span>
                <span className={priority.className}>{priority.label}</span>
                <span>·</span>
                <span>{formatDateTh(ticket.createdAt)}</span>
                {ticket.photoR2Keys.length > 0 ? (
                  <span>· 📷 {ticket.photoR2Keys.length}</span>
                ) : null}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Thai short date for the list — sufficient for ops scanning. Detail page
 * shows full ISO timestamp.
 */
function formatDateTh(date: Date): string {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}
