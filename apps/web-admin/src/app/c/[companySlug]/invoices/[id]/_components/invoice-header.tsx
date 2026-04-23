import { Card, CardContent } from '@/components/ui/card';
import type { InvoiceWire } from '@/queries/invoices';
import type { InvoiceStatus } from '@dorm/shared/zod';

/**
 * Invoice header card — pure markup (Server Component).
 *
 * Status colour map mirrors invoices-table.tsx — keep them in sync if
 * either side changes. Could be lifted to a shared util once a 3rd consumer
 * appears (premature abstraction otherwise per CLAUDE.md §8).
 */
export function InvoiceHeader({ invoice }: { invoice: InvoiceWire }) {
  const dateFormatter = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
  });

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">รอบบิล</p>
            <p className="font-mono text-lg font-semibold">{invoice.period}</p>
          </div>
          <StatusBadge status={invoice.status} />
        </div>

        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <Field label="ยูนิต" value={invoice.unitId} mono />
          <Field label="ผู้เช่า" value={invoice.tenantId} mono />
          <Field label="ออกบิลเมื่อ" value={dateFormatter.format(invoice.issueDate)} />
          <Field label="ครบกำหนด" value={dateFormatter.format(invoice.dueDate)} />
          {invoice.promptPayRef ? (
            <Field label="PromptPay" value={invoice.promptPayRef} mono />
          ) : null}
        </div>

        <div className="flex items-baseline justify-between border-t pt-4">
          <span className="text-sm text-muted-foreground">ยอดรวม</span>
          <span className="font-mono text-2xl font-semibold">{formatTHB(invoice.total)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={mono ? 'font-mono text-xs' : 'text-sm'}>{value}</p>
    </div>
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
    <span className={`inline-flex rounded px-3 py-1 text-sm font-medium ${STATUS_CLASS[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

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
