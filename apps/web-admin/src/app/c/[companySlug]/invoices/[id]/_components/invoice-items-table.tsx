import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { InvoiceItemWire } from '@/queries/invoices';
import type { InvoiceItemKind } from '@dorm/shared/zod';

/**
 * Invoice line items — pure markup (Server Component).
 *
 * Items arrive sorted by `sortOrder` from the API. We render them as-is
 * (no client-side re-sort) so a tester can easily reproduce wire order
 * during smoke tests.
 */
export function InvoiceItemsTable({ items }: { items: readonly InvoiceItemWire[] }) {
  if (items.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>รายการในบิล</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">ไม่มีรายการ</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b">
        <CardTitle>รายการในบิล</CardTitle>
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left font-medium">ประเภท</th>
              <th className="px-4 py-3 text-left font-medium">รายละเอียด</th>
              <th className="px-4 py-3 text-right font-medium">จำนวน</th>
              <th className="px-4 py-3 text-right font-medium">ราคาต่อหน่วย</th>
              <th className="px-4 py-3 text-right font-medium">ยอด</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((item) => (
              <tr key={item.id} className="hover:bg-muted/30">
                <td className="px-4 py-3">{KIND_LABEL[item.kind]}</td>
                <td className="px-4 py-3 text-muted-foreground">{item.description}</td>
                <td className="px-4 py-3 text-right font-mono text-xs">{item.quantity}</td>
                <td className="px-4 py-3 text-right font-mono text-xs">{item.unitPrice}</td>
                <td className="px-4 py-3 text-right font-mono">{formatTHB(item.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const KIND_LABEL: Record<InvoiceItemKind, string> = {
  rent: 'ค่าเช่า',
  water: 'ค่าน้ำ',
  electric: 'ค่าไฟ',
  common_fee: 'ค่าส่วนกลาง',
  late_fee: 'ค่าปรับล่าช้า',
  deposit: 'เงินประกัน',
  other: 'อื่นๆ',
};

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
