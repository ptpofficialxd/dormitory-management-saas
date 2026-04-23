import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { type InvoicePage, invoicePageSchema } from '@/queries/invoices';
import { ChevronRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { GenerateInvoicesButton } from './_components/generate-invoices-button';
import { InvoiceFilters } from './_components/invoice-filters';
import { InvoicesTable } from './_components/invoices-table';

export const metadata: Metadata = {
  title: 'ใบแจ้งหนี้',
};

interface InvoicesPageProps {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{
    period?: string;
    status?: string;
    cursor?: string;
  }>;
}

/**
 * /c/[companySlug]/invoices — list view.
 *
 * Filter design:
 * - URL-driven (`?period=2026-04&status=issued`) so the state survives
 *   navigation + share-by-link. The `<InvoiceFilters>` Client Component
 *   pushes new searchParams via `useRouter` on change.
 * - Backend honours `period`, `status`, `tenantId` filters; `tenantId` is
 *   not surfaced in the UI yet — operator typically scans by period first.
 *
 * Pagination:
 * - Cursor-based (opaque base64). Filter params are preserved on the
 *   "next page" link so the cursor stays valid.
 *
 * RBAC:
 * - The route itself is gated by AdminShell's nav filter (read:invoice).
 * - The "Generate" button is `<Can action="create" resource="invoice">` —
 *   shows only for owner/manager. API enforces the same matrix.
 */
export default async function InvoicesPage({ params, searchParams }: InvoicesPageProps) {
  const { companySlug } = await params;
  const sp = await searchParams;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/invoices`);
  }

  const queryString = buildQueryString({
    period: sp.period,
    status: sp.status,
    cursor: sp.cursor,
  });

  let page: InvoicePage;
  try {
    page = await api.get(`/c/${companySlug}/invoices${queryString}`, invoicePageSchema, {
      token,
    });
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.statusCode === 401 || err.code === 'UnauthorizedException')
    ) {
      redirect(`/login?next=/c/${companySlug}/invoices`);
    }
    console.error('[invoices/list] failed to load:', err);
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

  // Preserve filter params on the "next" link so the cursor remains
  // consistent with the filtered set.
  const nextLinkQuery = page.nextCursor
    ? buildQueryString({ period: sp.period, status: sp.status, cursor: page.nextCursor })
    : '';

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">ใบแจ้งหนี้</h1>
          <p className="text-sm text-muted-foreground">
            จัดการใบแจ้งหนี้ของผู้เช่า ({page.items.length}
            {page.nextCursor ? '+ ' : ' '}รายการ)
          </p>
        </div>
        <GenerateInvoicesButton companySlug={companySlug} />
      </div>

      <InvoiceFilters
        companySlug={companySlug}
        currentPeriod={sp.period}
        currentStatus={sp.status}
      />

      <InvoicesTable items={page.items} companySlug={companySlug} />

      {page.nextCursor ? (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link href={`/c/${companySlug}/invoices${nextLinkQuery}`}>
              หน้าถัดไป
              <ChevronRight className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Build a `?key=value&...` string from the supplied params, dropping any
 * undefined / empty entries. Returns `''` when no params are present so the
 * caller can concatenate it without a conditional.
 */
function buildQueryString(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
  );
  if (entries.length === 0) return '';
  const usp = new URLSearchParams(entries);
  return `?${usp.toString()}`;
}
