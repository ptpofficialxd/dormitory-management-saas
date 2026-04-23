import { Card, CardContent } from '@/components/ui/card';
import type { PaymentWire } from '@/queries/payments';
import { Wallet } from 'lucide-react';
import { PaymentRow } from './payment-row';

/**
 * Payment list — Server Component shell.
 *
 * Maps over the page items and renders one <PaymentRow /> (Client) per
 * row. The list itself stays Server so we don't ship the array of
 * payments through a Client serialisation boundary unnecessarily.
 */
export function PaymentsList({
  payments,
  companySlug,
}: {
  payments: readonly PaymentWire[];
  companySlug: string;
}) {
  if (payments.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <Wallet className="h-10 w-10 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">ไม่มีรายการที่ตรงกับตัวกรอง</p>
            <p className="text-xs text-muted-foreground">ลองเปลี่ยนสถานะด้านบน หรือรอให้ผู้เช่าส่งสลิปใหม่</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="divide-y overflow-hidden">
      {payments.map((payment) => (
        <PaymentRow key={payment.id} payment={payment} companySlug={companySlug} />
      ))}
    </Card>
  );
}
