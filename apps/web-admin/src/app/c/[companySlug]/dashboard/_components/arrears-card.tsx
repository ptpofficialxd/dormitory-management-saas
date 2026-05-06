import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ArrearsBucket, DashboardArrears } from '@/queries/dashboard';
import { formatTHB } from '@dorm/shared/money';

interface ArrearsCardProps {
  data: DashboardArrears;
}

/**
 * Arrears aging — money the company is owed, bucketed by how late the
 * invoice is. Headline = total; rows below break it down.
 *
 * Color cues (Tailwind palette):
 *   - 1-30 days  → amber  (early, recoverable with a polite nudge)
 *   - 31-60 days → orange (escalating, deserves attention)
 *   - 60+ days   → red    (legal-template territory)
 *
 * v1 simplification documented in arrearsBucketSchema: `amount` is the
 * face total of overdue invoices (not unpaid remainder). Acceptable for
 * Thai dorm partial-pay rate.
 */
export function ArrearsCard({ data }: ArrearsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">ค้างชำระ</CardTitle>
        <CardDescription>{data.total.count} ใบ รวมทุกอายุหนี้</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">ยอดรวม</p>
          <p className="font-mono text-3xl font-semibold tabular-nums">
            {formatTHB(data.total.amount)}
          </p>
        </div>
        <div className="space-y-2 border-t pt-3">
          <BucketRow label="1–30 วัน" tone="amber" bucket={data.bucket1to30} />
          <BucketRow label="31–60 วัน" tone="orange" bucket={data.bucket31to60} />
          <BucketRow label="เกิน 60 วัน" tone="red" bucket={data.bucket60plus} />
        </div>
      </CardContent>
    </Card>
  );
}

interface BucketRowProps {
  label: string;
  tone: 'amber' | 'orange' | 'red';
  bucket: ArrearsBucket;
}

const TONE_DOT: Record<BucketRowProps['tone'], string> = {
  amber: 'bg-amber-500',
  orange: 'bg-orange-500',
  red: 'bg-red-500',
};

function BucketRow({ label, tone, bucket }: BucketRowProps) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} aria-hidden />
        <span className="text-muted-foreground">{label}</span>
      </div>
      <div className="flex items-baseline gap-3">
        <span className="text-xs text-muted-foreground tabular-nums">{bucket.count} ใบ</span>
        <span className="font-mono font-medium tabular-nums">{formatTHB(bucket.amount)}</span>
      </div>
    </div>
  );
}
