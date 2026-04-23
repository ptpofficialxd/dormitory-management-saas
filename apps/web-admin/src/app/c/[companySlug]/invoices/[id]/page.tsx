import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { type InvoiceWire, invoiceWireSchema } from '@/queries/invoices';
import { type PaymentPage, paymentPageSchema } from '@/queries/payments';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { InvoiceActions } from './_components/invoice-actions';
import { InvoiceHeader } from './_components/invoice-header';
import { InvoiceItemsTable } from './_components/invoice-items-table';
import { PaymentHistory } from './_components/payment-history';

export const metadata: Metadata = {
  title: 'รายละเอียดใบแจ้งหนี้',
};

interface InvoiceDetailPageProps {
  params: Promise<{ companySlug: string; id: string }>;
}

/**
 * /c/[companySlug]/invoices/[id] — invoice detail.
 *
 * Two parallel fetches via Promise.all:
 *   - GET /invoices/:id        → invoice + items
 *   - GET /payments?invoiceId  → payment history (cursor-paginated; we take
 *                                 the first page for MVP — operators rarely
 *                                 see more than ~3 payments per invoice)
 *
 * 404 handling: if the invoice doesn't exist the API returns 404 → we render
 * a "not found" card rather than crashing.
 *
 * Action mutations live in <InvoiceActions> (Client) — they call Server
 * Actions in `actions/invoices.ts` which `revalidatePath` this route on
 * success, triggering a re-render with the new status.
 */
export default async function InvoiceDetailPage({ params }: InvoiceDetailPageProps) {
  const { companySlug, id } = await params;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/invoices/${id}`);
  }

  let invoice: InvoiceWire;
  let payments: PaymentPage;
  try {
    [invoice, payments] = await Promise.all([
      api.get(`/c/${companySlug}/invoices/${id}`, invoiceWireSchema, { token }),
      api.get(`/c/${companySlug}/payments?invoiceId=${encodeURIComponent(id)}`, paymentPageSchema, {
        token,
      }),
    ]);
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.statusCode === 401 || err.code === 'UnauthorizedException')
    ) {
      redirect(`/login?next=/c/${companySlug}/invoices/${id}`);
    }
    if (err instanceof ApiError && (err.statusCode === 404 || err.code === 'NotFoundException')) {
      return <NotFoundCard companySlug={companySlug} />;
    }
    console.error('[invoices/detail] failed to load:', err);
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

  return (
    <div className="space-y-4">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link href={`/c/${companySlug}/invoices`}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            กลับไปรายการ
          </Link>
        </Button>
      </div>

      <InvoiceHeader invoice={invoice} />

      <InvoiceActions companySlug={companySlug} invoiceId={invoice.id} status={invoice.status} />

      <InvoiceItemsTable items={invoice.items} />

      <PaymentHistory payments={payments.items} />
    </div>
  );
}

function NotFoundCard({ companySlug }: { companySlug: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>ไม่พบใบแจ้งหนี้</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">ใบแจ้งหนี้ที่เรียกอาจถูกลบ หรือคุณอาจไม่มีสิทธิ์เข้าถึง</p>
        <Button asChild size="sm" variant="outline">
          <Link href={`/c/${companySlug}/invoices`}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            กลับไปรายการ
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
