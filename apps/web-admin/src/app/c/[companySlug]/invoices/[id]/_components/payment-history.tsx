import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { PaymentWire } from '@/queries/payments';
import type { PaymentMethod, PaymentStatus } from '@dorm/shared/zod';

/**
 * Payment history for a single invoice — pure markup (Server Component).
 *
 * Shows the most recent first (sort flipped client-side; the API returns
 * cursor-paginated rows in DB order). Each row links to the slip viewer
 * (Task #68) once that page exists; for now show a placeholder.
 */
export function PaymentHistory({ payments }: { payments: readonly PaymentWire[] }) {
  if (payments.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>ประวัติการชำระ</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">ยังไม่มีการชำระเงินสำหรับบิลนี้</p>
        </CardContent>
      </Card>
    );
  }

  const dateTimeFormatter = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  // Newest first — operator typically scans the most recent payment to act on.
  const sorted = [...payments].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b">
        <CardTitle>ประวัติการชำระ</CardTitle>
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left font-medium">วันที่</th>
              <th className="px-4 py-3 text-left font-medium">วิธี</th>
              <th className="px-4 py-3 text-right font-medium">ยอด</th>
              <th className="px-4 py-3 text-left font-medium">สถานะ</th>
              <th className="px-4 py-3 text-left font-medium">หมายเหตุ</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {sorted.map((p) => (
              <tr key={p.id} className="hover:bg-muted/30">
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {dateTimeFormatter.format(p.createdAt)}
                </td>
                <td className="px-4 py-3">{METHOD_LABEL[p.method]}</td>
                <td className="px-4 py-3 text-right font-mono">{formatTHB(p.amount)}</td>
                <td className="px-4 py-3">
                  <PaymentStatusBadge status={p.status} />
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {p.status === 'rejected' && p.rejectionReason
                    ? `เหตุผล: ${p.rejectionReason}`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const METHOD_LABEL: Record<PaymentMethod, string> = {
  promptpay: 'PromptPay',
  cash: 'เงินสด',
  bank_transfer: 'โอนผ่านธนาคาร',
};

const PAYMENT_STATUS_CLASS: Record<PaymentStatus, string> = {
  pending: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  confirmed: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  rejected: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
};

const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: 'รอตรวจสอบ',
  confirmed: 'ยืนยันแล้ว',
  rejected: 'ปฏิเสธ',
};

function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${PAYMENT_STATUS_CLASS[status]}`}
    >
      {PAYMENT_STATUS_LABEL[status]}
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
