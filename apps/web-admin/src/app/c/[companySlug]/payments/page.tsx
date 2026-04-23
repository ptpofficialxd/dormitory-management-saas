import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { type PaymentPage, paymentPageSchema } from '@/queries/payments';
import { ChevronRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PaymentStatusFilter } from './_components/payment-status-filter';
import { PaymentsList } from './_components/payments-list';

export const metadata: Metadata = {
  title: 'การชำระเงิน',
};

interface PaymentsPageProps {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{ status?: string; cursor?: string }>;
}

/**
 * /c/[companySlug]/payments — slip review queue.
 *
 * The default status filter is `pending` because this is the daily-ops
 * page: operators come here to triage incoming slips. Other statuses are
 * reachable via the filter dropdown for audit / dispute lookup.
 *
 * Each row is expandable in-place to reveal the slip image (signed URL,
 * minted on demand by a Server Action with TTL ≤5 min per CLAUDE.md §3 #9)
 * and the approve / reject controls. RBAC gates live inside the row
 * Client Component.
 *
 * Design tradeoff: we don't surface tenant or invoice display names yet —
 * just IDs (truncated). Phase 2: enrich the wire schema with denormalised
 * tenant.displayName + invoice.period so the operator can scan rows
 * without clicking through.
 */
export default async function PaymentsPage({ params, searchParams }: PaymentsPageProps) {
  const { companySlug } = await params;
  const sp = await searchParams;

  const token = await getAccessTokenFromCookie();
  if (!token) redirect(`/login?next=/c/${companySlug}/payments`);

  // Default to "pending" so the queue shows what needs attention. Empty
  // string means "all statuses" (operator opted-in via the filter).
  const status = sp.status === undefined ? 'pending' : sp.status;
  const queryString = buildQueryString({ status, cursor: sp.cursor });

  let page: PaymentPage;
  try {
    page = await api.get(`/c/${companySlug}/payments${queryString}`, paymentPageSchema, { token });
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.statusCode === 401 || err.code === 'UnauthorizedException')
    ) {
      redirect(`/login?next=/c/${companySlug}/payments`);
    }
    console.error('[payments/list] failed to load:', err);
    return (
      <Card>
        <CardHeader>
          <CardTitle>โหลดข้อมูลไม่สำเร็จ</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            กรุณาลองรีเฟรชหน้านี้ หรือติดต่อทีมเทคนิคหากปัญหายังเกิดขึ้น
          </p>
        </CardContent>
      </Card>
    );
  }

  const nextLinkQuery = page.nextCursor
    ? buildQueryString({ status, cursor: page.nextCursor })
    : '';

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">การชำระเงิน</h1>
        <p className="text-sm text-muted-foreground">
          ตรวจสอบสลิปและยืนยันการชำระจากผู้เช่า ({page.items.length}
          {page.nextCursor ? '+ ' : ' '}รายการ)
        </p>
      </div>

      <PaymentStatusFilter companySlug={companySlug} currentStatus={status} />

      <PaymentsList payments={page.items} companySlug={companySlug} />

      {page.nextCursor ? (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link href={`/c/${companySlug}/payments${nextLinkQuery}`}>
              หน้าถัดไป
              <ChevronRight className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function buildQueryString(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
  );
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries).toString()}`;
}
