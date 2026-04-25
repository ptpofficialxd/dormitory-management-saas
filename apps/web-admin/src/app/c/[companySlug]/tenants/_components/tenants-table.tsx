import { Card, CardContent } from '@/components/ui/card';
import { maskNationalId, maskPhone } from '@/lib/pii';
import type { TenantWire } from '@/queries/tenants';
import { Users } from 'lucide-react';
import Link from 'next/link';

/**
 * Tenants table — Server Component, pure markup.
 *
 * PII rendering: list view shows MASKED phone / national ID always —
 * "reveal" lives on the detail page where it's explicit per-record.
 * Mirrors Properties table pattern (Task #62) + adds:
 *   - status badge column
 *   - row → detail page link (clickable name)
 *   - LINE-bound indicator (filled vs hollow icon)
 *
 * Phase 2 wishlist: column sort, inline status quick-toggle, search by
 * displayName.
 */
export function TenantsTable({
  companySlug,
  items,
}: {
  companySlug: string;
  items: readonly TenantWire[];
}) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <Users className="h-10 w-10 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">ยังไม่มีผู้เช่า</p>
            <p className="text-xs text-muted-foreground">คลิก "เพิ่มผู้เช่า" ที่มุมขวาบนเพื่อเริ่มต้น</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const dateFormatter = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
  });

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left font-medium">ชื่อ</th>
              <th className="px-4 py-3 text-left font-medium">โทรศัพท์</th>
              <th className="px-4 py-3 text-left font-medium">เลขบัตร</th>
              <th className="px-4 py-3 text-left font-medium">LINE</th>
              <th className="px-4 py-3 text-left font-medium">สถานะ</th>
              <th className="px-4 py-3 text-left font-medium">เพิ่มเมื่อ</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((t) => (
              <tr key={t.id} className="hover:bg-muted/30">
                <td className="px-4 py-3 font-medium">
                  <Link
                    href={`/c/${companySlug}/tenants/${t.id}`}
                    className="text-primary hover:underline"
                  >
                    {t.displayName}
                  </Link>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {maskPhone(t.phone)}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {maskNationalId(t.nationalId)}
                </td>
                <td className="px-4 py-3 text-xs">
                  {t.lineUserId ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-line-green/15 px-2 py-0.5 text-line-green">
                      <span className="h-1.5 w-1.5 rounded-full bg-line-green" />
                      ผูกแล้ว
                    </span>
                  ) : (
                    <span className="text-muted-foreground">ยังไม่ผูก</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={t.status} />
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {dateFormatter.format(t.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * Status badge — colour-coded per `tenant_status` enum.
 *   active     → green (พักอยู่)
 *   moved_out  → grey (ย้ายออก)
 *   blocked    → red (ระงับ)
 *
 * Tailwind utility classes only (no shadcn `<Badge>` to keep this
 * Server-Component-friendly + zero JS overhead for the list).
 */
function StatusBadge({ status }: { status: 'active' | 'moved_out' | 'blocked' }) {
  const styles: Record<typeof status, string> = {
    active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    moved_out: 'bg-muted text-muted-foreground',
    blocked: 'bg-destructive/15 text-destructive',
  };
  const labels: Record<typeof status, string> = {
    active: 'พักอยู่',
    moved_out: 'ย้ายออก',
    blocked: 'ระงับ',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}
