import { Card, CardContent } from '@/components/ui/card';
import type { ContractStatus, ContractWire } from '@/queries/contracts';
import { FileText } from 'lucide-react';
import Link from 'next/link';

/**
 * Contracts table — Server Component, pure markup.
 *
 * `tenantNameById` is built from a parallel `/tenants` fetch on the page —
 * we'd rather render a name than a raw UUID. Phase 2: API endpoint returns
 * the join eagerly so we don't N+1 the directory call here.
 *
 * `unitName` we leave as the unitId for now (no unit dictionary yet) —
 * Phase 2 wishlist: same pattern as tenants. For MVP the row click goes
 * to the detail page where the unit number renders properly.
 */
export function ContractsTable({
  companySlug,
  items,
  tenantNameById,
}: {
  companySlug: string;
  items: readonly ContractWire[];
  tenantNameById: Record<string, string>;
}) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <FileText className="h-10 w-10 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">ยังไม่มีสัญญา</p>
            <p className="text-xs text-muted-foreground">คลิก "เพิ่มสัญญา" ที่มุมขวาบนเพื่อสร้างสัญญาแรก</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const dateFormatter = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
  });
  const moneyFormatter = new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'THB',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left font-medium">ผู้เช่า</th>
              <th className="px-4 py-3 text-left font-medium">เริ่ม</th>
              <th className="px-4 py-3 text-left font-medium">สิ้นสุด</th>
              <th className="px-4 py-3 text-right font-medium">ค่าเช่า</th>
              <th className="px-4 py-3 text-right font-medium">เงินประกัน</th>
              <th className="px-4 py-3 text-left font-medium">สถานะ</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((c) => (
              <tr key={c.id} className="hover:bg-muted/30">
                <td className="px-4 py-3 font-medium">
                  <Link
                    href={`/c/${companySlug}/contracts/${c.id}`}
                    className="text-primary hover:underline"
                  >
                    {tenantNameById[c.tenantId] ?? '— ไม่ทราบชื่อ —'}
                  </Link>
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {dateFormatter.format(new Date(c.startDate))}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {c.endDate ? dateFormatter.format(new Date(c.endDate)) : 'ไม่กำหนด'}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs">
                  {moneyFormatter.format(Number(c.rentAmount))}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                  {moneyFormatter.format(Number(c.depositAmount))}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={c.status} />
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
 * Status badge — colour-coded per `contract_status` enum.
 *   draft       → gray (ร่าง)
 *   active      → green (ใช้งาน)
 *   ended       → blue (ครบกำหนด)
 *   terminated  → red (ยกเลิก)
 */
function StatusBadge({ status }: { status: ContractStatus }) {
  const styles: Record<ContractStatus, string> = {
    draft: 'bg-muted text-muted-foreground',
    active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    ended: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
    terminated: 'bg-destructive/15 text-destructive',
  };
  const labels: Record<ContractStatus, string> = {
    draft: 'ร่าง',
    active: 'ใช้งาน',
    ended: 'ครบกำหนด',
    terminated: 'ยกเลิก',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}
