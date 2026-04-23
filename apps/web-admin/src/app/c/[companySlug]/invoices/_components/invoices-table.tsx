import { Card, CardContent } from '@/components/ui/card';
import type { InvoiceWire } from '@/queries/invoices';
import type { InvoiceStatus } from '@dorm/shared/zod';
import { Receipt } from 'lucide-react';
import Link from 'next/link';

/**
 * Invoices table — pure markup (Server Component).
 *
 * Status colours follow a traffic-light convention so the operator can
 * triage at a glance:
 *   - draft           neutral grey   (not yet billed)
 *   - issued          blue           (sent, awaiting payment)
 *   - partially_paid  amber          (action needed — collect the rest)
 *   - paid            green          (settled)
 *   - void            grey strike    (cancelled — kept for audit)
 *   - overdue         red            (past due, escalate)
 */
export function InvoicesTable({
  items,
  companySlug,
}: {
  items: readonly InvoiceWire[];
  companySlug: string;
}) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <Receipt className="h-10 w-10 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">ไม่มีใบแจ้งหนี้</p>
            <p className="text-xs text-muted-foreground">
              ลองปรับตัวกรองด้านบน หรือกด "สร้างใบแจ้งหนี้" เพื่อสร้างรอบบิลใหม่
            </p>
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
              <th className="px-4 py-3 text-left font-medium">รอบบิล</th>
              <th className="px-4 py-3 text-left font-medium">ยูนิต / ผู้เช่า</th>
              <th className="px-4 py-3 text-right font-medium">ยอดรวม</th>
              <th className="px-4 py-3 text-left font-medium">ครบกำหนด</th>
              <th className="px-4 py-3 text-left font-medium">สถานะ</th>
              <th className="px-4 py-3 text-right font-medium" aria-label="actions" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((inv) => (
              <tr key={inv.id} className="hover:bg-muted/30">
                <td className="px-4 py-3 font-mono text-xs">{inv.period}</td>
                <td className="px-4 py-3">
                  <div className="font-medium">{inv.unitId.slice(0, 8)}…</div>
                  <div className="text-xs text-muted-foreground">{inv.tenantId.slice(0, 8)}…</div>
                </td>
                <td className="px-4 py-3 text-right font-mono">{formatTHB(inv.total)}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {dateFormatter.format(inv.dueDate)}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={inv.status} />
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/c/${companySlug}/invoices/${inv.id}`}
                    className="text-xs text-primary underline-offset-2 hover:underline"
                  >
                    ดูรายละเอียด
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const STATUS_CLASS: Record<InvoiceStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  issued: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  partially_paid: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  paid: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  void: 'bg-muted text-muted-foreground line-through',
  overdue: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
};

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: 'ร่าง',
  issued: 'ออกบิลแล้ว',
  partially_paid: 'ชำระบางส่วน',
  paid: 'ชำระแล้ว',
  void: 'ยกเลิก',
  overdue: 'เกินกำหนด',
};

function StatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Format Decimal-string money (e.g. "5000.00") as Thai-locale THB.
 * The string-form is the wire format per packages/shared/src/zod/primitives.ts
 * (`moneySchema`), so we never round-trip through `Number` and lose precision.
 */
function formatTHB(value: string): string {
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  return new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'THB',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}
