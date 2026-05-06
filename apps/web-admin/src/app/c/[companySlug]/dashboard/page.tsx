import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { dashboardSummarySchema } from '@/queries/dashboard';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ArrearsCard } from './_components/arrears-card';
import { OccupancyCard } from './_components/occupancy-card';
import { PipelineStrip } from './_components/pipeline-strip';
import { RevenueCard } from './_components/revenue-card';

export const metadata: Metadata = {
  title: 'แดชบอร์ด',
};

interface DashboardPageProps {
  params: Promise<{ companySlug: string }>;
}

/**
 * /c/[companySlug]/dashboard — admin home.
 *
 * Server Component fetches the entire summary in one round-trip
 * (`GET /c/:slug/dashboard/summary`) and hands the parsed object to four
 * presentational components. No client-side data fetch — first paint is
 * fully rendered HTML so the dashboard loads as fast as the static layout.
 *
 * Refresh model: user reloads the page (browser refresh / nav back). No
 * auto-poll in MVP — admin sessions are short and the underlying data
 * (cashflow + occupancy) doesn't move minute-to-minute. Phase 1 wishlist:
 * SSE or `revalidate=60` once we know how often admins keep this open.
 *
 * Failure modes:
 *   - 401 (token expired or revoked) → bounce to /login with `next` back
 *   - other ApiError / network errors → render an error Card so the rest
 *     of the shell (sidebar, breadcrumb) still works and the user can
 *     navigate elsewhere
 */
export default async function DashboardPage({ params }: DashboardPageProps) {
  const { companySlug } = await params;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/dashboard`);
  }

  try {
    const summary = await api.get(`/c/${companySlug}/dashboard/summary`, dashboardSummarySchema, {
      token,
    });

    return (
      <div className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold tracking-tight">ภาพรวมหอพัก</h1>
          <p className="text-xs text-muted-foreground">
            อัปเดตเมื่อ {formatBangkokTime(summary.asOf)}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <RevenueCard data={summary.revenue} period={summary.period} />
          <ArrearsCard data={summary.arrears} />
          <OccupancyCard data={summary.occupancy} />
        </div>

        <PipelineStrip companySlug={companySlug} data={summary.pipeline} />
      </div>
    );
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 401) {
      redirect(`/login?next=/c/${companySlug}/dashboard`);
    }
    console.error('[dashboard] failed to load summary:', err);
    return (
      <Card>
        <CardHeader>
          <CardTitle>โหลดแดชบอร์ดไม่สำเร็จ</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            ระบบไม่สามารถดึงข้อมูลสรุปได้ในขณะนี้ — กรุณารีเฟรชหน้าหรือแจ้งผู้ดูแลระบบหากปัญหายังคงอยู่
          </p>
        </CardContent>
      </Card>
    );
  }
}

/**
 * `2026-05-06T10:00:00Z` → `17:00 น.` (Bangkok wall-clock).
 *
 * Server-rendered → no hydration round-trip. Uses `Intl.DateTimeFormat`
 * with `timeZone: 'Asia/Bangkok'` so the same source instant always
 * displays as Thai local time regardless of where the Node server runs.
 */
function formatBangkokTime(asOf: Date): string {
  const formatted = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(asOf);
  return `${formatted} น.`;
}
