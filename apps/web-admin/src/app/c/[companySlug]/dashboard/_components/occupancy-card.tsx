import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { DashboardOccupancy } from '@/queries/dashboard';

interface OccupancyCardProps {
  data: DashboardOccupancy;
}

/**
 * Occupancy snapshot — one big rate %, then the unit breakdown.
 *
 * Empty-company case: server returns `rate=0` (not NaN); we render `—` for
 * the percentage so users don't see a confusing "0%" for a brand-new
 * company that hasn't added units yet.
 */
export function OccupancyCard({ data }: OccupancyCardProps) {
  const ratePct = data.totalUnits === 0 ? null : Math.round(data.rate * 100);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">อัตราเข้าพัก</CardTitle>
        <CardDescription>
          {data.occupiedUnits} จาก {data.totalUnits} ห้อง
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">เปอร์เซ็นต์</p>
          <p className="font-mono text-3xl font-semibold tabular-nums">
            {ratePct === null ? '—' : `${ratePct}%`}
          </p>
        </div>
        <div className="space-y-2 border-t pt-3 text-sm">
          <StatusRow label="พักอยู่" tone="emerald" count={data.occupiedUnits} />
          <StatusRow label="ว่าง" tone="slate" count={data.vacantUnits} />
          <StatusRow label="ซ่อมบำรุง" tone="amber" count={data.maintenanceUnits} />
          <StatusRow label="จอง" tone="sky" count={data.reservedUnits} />
        </div>
      </CardContent>
    </Card>
  );
}

const TONE_DOT: Record<'emerald' | 'slate' | 'amber' | 'sky', string> = {
  emerald: 'bg-emerald-500',
  slate: 'bg-slate-400',
  amber: 'bg-amber-500',
  sky: 'bg-sky-500',
};

function StatusRow({
  label,
  tone,
  count,
}: {
  label: string;
  tone: keyof typeof TONE_DOT;
  count: number;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} aria-hidden />
        <span className="text-muted-foreground">{label}</span>
      </div>
      <span className="font-medium tabular-nums">{count}</span>
    </div>
  );
}
