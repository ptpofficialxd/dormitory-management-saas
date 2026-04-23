import { Card, CardContent } from '@/components/ui/card';
import type { UnitWire } from '@/queries/units';
import { DoorOpen } from 'lucide-react';

/**
 * Unit status → Thai label + Tailwind colour for the status pill.
 *
 * Order mirrors the lifecycle: vacant → reserved → occupied → maintenance.
 * Colours are kept inside the table file so the matrix lives next to the
 * thing that renders it.
 */
const STATUS_LABELS: Record<UnitWire['status'], { label: string; className: string }> = {
  vacant: { label: 'ว่าง', className: 'bg-emerald-100 text-emerald-700' },
  reserved: { label: 'จองแล้ว', className: 'bg-amber-100 text-amber-700' },
  occupied: { label: 'มีผู้เช่า', className: 'bg-blue-100 text-blue-700' },
  maintenance: { label: 'ซ่อม/ปิด', className: 'bg-rose-100 text-rose-700' },
};

const moneyFormatter = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

interface UnitsTableProps {
  items: readonly UnitWire[];
  /** Lookup so the table can render `propertyId` as the property's friendly name. */
  propertyNameById: Map<string, string>;
}

export function UnitsTable({ items, propertyNameById }: UnitsTableProps) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <DoorOpen className="h-10 w-10 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">ยังไม่มีห้อง</p>
            <p className="text-xs text-muted-foreground">คลิก "เพิ่มห้อง" เพื่อเริ่มต้น</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left font-medium">เลขห้อง</th>
              <th className="px-4 py-3 text-left font-medium">อาคาร</th>
              <th className="px-4 py-3 text-left font-medium">ชั้น</th>
              <th className="px-4 py-3 text-right font-medium">ค่าเช่า/เดือน</th>
              <th className="px-4 py-3 text-right font-medium">ขนาด</th>
              <th className="px-4 py-3 text-left font-medium">สถานะ</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((u) => {
              const status = STATUS_LABELS[u.status];
              return (
                <tr key={u.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{u.unitNumber}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {propertyNameById.get(u.propertyId) ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{u.floor}</td>
                  <td className="px-4 py-3 text-right font-mono">
                    {moneyFormatter.format(Number(u.baseRent))}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-muted-foreground">
                    {u.sizeSqm ? `${u.sizeSqm} m²` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${status.className}`}
                    >
                      {status.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
