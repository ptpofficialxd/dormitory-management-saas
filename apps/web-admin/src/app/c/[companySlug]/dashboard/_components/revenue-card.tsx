import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { DashboardRevenue } from '@/queries/dashboard';
import { formatTHB } from '@dorm/shared/money';

interface RevenueCardProps {
  data: DashboardRevenue;
  /** Bangkok-local YYYY-MM the figures cover. Rendered in the description. */
  period: string;
}

/**
 * Revenue snapshot for the current Bangkok-local month.
 *
 * Two figures stacked:
 *   1. CONFIRMED — sum of payments admin has approved (money in the bank).
 *   2. PENDING — slips waiting for admin review (money on the way).
 *
 * Pending uses muted text + a smaller hierarchy so admins read confirmed
 * first; pending is supporting context, not the headline.
 */
export function RevenueCard({ data, period }: RevenueCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">รายรับเดือนนี้</CardTitle>
        <CardDescription>รอบบิล {formatPeriodLabel(period)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">ยืนยันแล้ว</p>
          <p className="font-mono text-3xl font-semibold tabular-nums">
            {formatTHB(data.confirmed)}
          </p>
        </div>
        <div className="border-t pt-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">รอ confirm สลิป</p>
          <p className="font-mono text-lg font-medium tabular-nums text-muted-foreground">
            {formatTHB(data.pendingConfirm)}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * `2026-05` → `พ.ค. 2569`. Server-rendered (no Intl.DateTimeFormat at the
 * client to avoid a hydration round-trip on the dashboard's first paint).
 */
function formatPeriodLabel(period: string): string {
  const [yearStr, monthStr] = period.split('-');
  const year = Number.parseInt(yearStr ?? '', 10);
  const month = Number.parseInt(monthStr ?? '', 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return period;
  }
  const months = [
    'ม.ค.',
    'ก.พ.',
    'มี.ค.',
    'เม.ย.',
    'พ.ค.',
    'มิ.ย.',
    'ก.ค.',
    'ส.ค.',
    'ก.ย.',
    'ต.ค.',
    'พ.ย.',
    'ธ.ค.',
  ];
  // Convert AD year to BE (พ.ศ.) — Thai users expect พ.ศ. in dorm context.
  return `${months[month - 1]} ${year + 543}`;
}
