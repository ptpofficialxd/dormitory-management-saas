import { Card, CardContent } from '@/components/ui/card';
import type { DashboardPipeline } from '@/queries/dashboard';
import Link from 'next/link';

interface PipelineStripProps {
  companySlug: string;
  data: DashboardPipeline;
}

/**
 * Three small KPIs that admins act on daily, rendered as a horizontal strip
 * below the headline cards. Each links to the page where the action happens
 * — clicking "5 รอ confirm" jumps to /payments?status=pending.
 *
 * Layout: 1 column on mobile, 3 columns on md+ — matches the headline grid
 * above for visual consistency.
 */
export function PipelineStrip({ companySlug, data }: PipelineStripProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <PipelineTile
        label="สัญญาที่ใช้งานอยู่"
        count={data.activeContracts}
        href={`/c/${companySlug}/contracts?status=active`}
      />
      <PipelineTile
        label="งานซ่อมที่ค้าง"
        count={data.openMaintenance}
        href={`/c/${companySlug}/maintenance`}
      />
      <PipelineTile
        label="สลิปรอ confirm"
        count={data.pendingPayments}
        href={`/c/${companySlug}/payments`}
      />
    </div>
  );
}

interface PipelineTileProps {
  label: string;
  count: number;
  href: string;
}

function PipelineTile({ label, count, href }: PipelineTileProps) {
  return (
    <Link href={href} className="block focus:outline-none focus:ring-2 focus:ring-ring rounded-lg">
      <Card className="transition-colors hover:bg-muted/40">
        <CardContent className="flex items-center justify-between py-4">
          <span className="text-sm text-muted-foreground">{label}</span>
          <span className="font-mono text-2xl font-semibold tabular-nums">{count}</span>
        </CardContent>
      </Card>
    </Link>
  );
}
