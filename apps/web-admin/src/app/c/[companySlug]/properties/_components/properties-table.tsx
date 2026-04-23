import { Card, CardContent } from '@/components/ui/card';
import type { PropertyWire } from '@/queries/properties';
import { Building2 } from 'lucide-react';

/**
 * Properties table — pure markup (Server Component).
 *
 * Phase 2 wishlist: row click → detail page, inline edit, occupancy summary.
 * For MVP we just render a static table.
 */
export function PropertiesTable({ items }: { items: readonly PropertyWire[] }) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <Building2 className="h-10 w-10 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">ยังไม่มีอาคาร</p>
            <p className="text-xs text-muted-foreground">คลิก "เพิ่มอาคาร" ที่มุมขวาบนเพื่อเริ่มต้น</p>
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
              <th className="px-4 py-3 text-left font-medium">รหัส</th>
              <th className="px-4 py-3 text-left font-medium">ชื่ออาคาร</th>
              <th className="px-4 py-3 text-left font-medium">ที่อยู่</th>
              <th className="px-4 py-3 text-left font-medium">สร้างเมื่อ</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((p) => (
              <tr key={p.id} className="hover:bg-muted/30">
                <td className="px-4 py-3 font-mono text-xs">{p.slug}</td>
                <td className="px-4 py-3 font-medium">{p.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{p.address ?? '—'}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {dateFormatter.format(p.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
