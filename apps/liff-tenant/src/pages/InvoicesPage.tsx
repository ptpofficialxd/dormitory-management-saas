import type { InvoiceStatus } from '@dorm/shared/zod';
import { type ReactNode, useMemo } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useTenantSession } from '../hooks/useTenantSession.js';
import { type InvoiceWire, useInvoices } from '../queries/invoices.js';

/**
 * /c/:companySlug/invoices — LIFF tenant home.
 *
 * Renders the tenant's bills (own only, server-enforced via JWT.sub on
 * /me/invoices). Click a row to open the detail page (Task #72) where
 * the user can upload a slip.
 *
 * State machine on mount:
 *   loading       → spinner
 *   not_in_client → "open in LINE app" copy
 *   needs_bind    → redirect to /c/:slug/bind (no code; user re-enters
 *                    from the deep link they were originally sent)
 *   error         → friendly retry card
 *   authenticated → fetch /me/invoices and render
 *
 * We don't show filter chips or a search box on the LIFF — tenants have
 * O(1-12) bills and scrolling beats UI chrome on a 375px screen.
 */
export function InvoicesPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  const slug = companySlug ?? '';
  const session = useTenantSession({ companySlug: slug });

  if (session.status === 'loading') {
    return (
      <Shell title="กำลังโหลด">
        <Spinner />
      </Shell>
    );
  }

  if (session.status === 'not_in_client') {
    return (
      <Shell title="เปิดในแอป LINE" accent="error">
        <p className="text-sm text-gray-600">
          กรุณาเปิดลิงก์นี้จากแอป LINE บนมือถือเท่านั้น (ไม่รองรับ browser ภายนอก)
        </p>
      </Shell>
    );
  }

  if (session.status === 'needs_bind') {
    // No invite code at this entry point — sending the user to /bind
    // without a code shows the "ลิงก์ไม่ถูกต้อง" guard which prompts
    // them to re-open the original admin-shared link. Better than a
    // dead-end on this page.
    return <Navigate to={`/c/${slug}/bind`} replace />;
  }

  if (session.status === 'error') {
    return (
      <Shell title="โหลดข้อมูลไม่สำเร็จ" accent="error">
        <p className="text-sm text-gray-600">{session.error}</p>
      </Shell>
    );
  }

  // session.status === 'authenticated'
  return <InvoicesView token={session.token} companySlug={slug} />;
}

// -------------------------------------------------------------------------
// Authenticated view — fetches and renders the invoice list
// -------------------------------------------------------------------------

function InvoicesView({ token, companySlug }: { token: string; companySlug: string }) {
  const { data, isLoading, isError, error, refetch } = useInvoices({ token });

  if (isLoading) {
    return (
      <Shell title="ใบแจ้งหนี้">
        <Spinner />
      </Shell>
    );
  }

  if (isError) {
    return (
      <Shell title="โหลดใบแจ้งหนี้ไม่สำเร็จ" accent="error">
        <p className="mb-3 text-sm text-gray-600">{error?.message ?? 'เกิดข้อผิดพลาด'}</p>
        <button type="button" className={btnPrimary} onClick={() => refetch()}>
          ลองอีกครั้ง
        </button>
      </Shell>
    );
  }

  const items = data?.items ?? [];

  if (items.length === 0) {
    return (
      <Shell title="ใบแจ้งหนี้">
        <p className="text-sm text-gray-600">ยังไม่มีใบแจ้งหนี้สำหรับบัญชีของคุณ</p>
        <p className="mt-1 text-xs text-gray-500">
          เมื่อทางหอพักออกบิลรอบใหม่ คุณจะได้รับแจ้งเตือนผ่าน LINE และเห็นรายการที่นี่
        </p>
      </Shell>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-stretch gap-3 px-4 pt-6 pb-6">
      <header className="px-1">
        <h1 className="text-xl font-semibold tracking-tight">ใบแจ้งหนี้ของคุณ</h1>
        <p className="text-xs text-gray-500">{items.length} รายการ</p>
      </header>
      <ul className="flex flex-col gap-2">
        {items.map((invoice) => (
          <li key={invoice.id}>
            <InvoiceRow invoice={invoice} companySlug={companySlug} />
          </li>
        ))}
      </ul>
    </main>
  );
}

// -------------------------------------------------------------------------
// Row card — one per invoice
// -------------------------------------------------------------------------

function InvoiceRow({ invoice, companySlug }: { invoice: InvoiceWire; companySlug: string }) {
  const dueLabel = useMemo(
    () =>
      new Intl.DateTimeFormat('th-TH', {
        timeZone: 'Asia/Bangkok',
        dateStyle: 'medium',
      }).format(invoice.dueDate),
    [invoice.dueDate],
  );

  return (
    <Link
      to={`/c/${companySlug}/invoices/${invoice.id}`}
      // The detail route lands in Task #72; until then this falls through
      // to <NotFound> on click — better than a dead anchor or wrong-protocol
      // hash, and the Link itself is forward-compatible.
      className="block rounded-2xl border border-gray-200 bg-white p-4 shadow-sm transition-colors active:bg-gray-50"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-sm text-gray-700">{invoice.period}</span>
        <StatusBadge status={invoice.status} />
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <span className="text-xs text-gray-500">ครบกำหนด {dueLabel}</span>
        <span className="font-mono text-base font-semibold text-gray-900">
          {formatTHB(invoice.total)}
        </span>
      </div>
    </Link>
  );
}

const STATUS_CLASS: Record<InvoiceStatus, string> = {
  draft: 'bg-gray-100 text-gray-700',
  issued: 'bg-blue-100 text-blue-800',
  partially_paid: 'bg-amber-100 text-amber-800',
  paid: 'bg-emerald-100 text-emerald-800',
  void: 'bg-gray-100 text-gray-500 line-through',
  overdue: 'bg-red-100 text-red-800',
};

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: 'ร่าง',
  issued: 'รอชำระ',
  partially_paid: 'ชำระบางส่วน',
  paid: 'ชำระแล้ว',
  void: 'ยกเลิก',
  overdue: 'เกินกำหนด',
};

function StatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${STATUS_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Format Decimal-string money (e.g. "5000.00") as Thai-locale THB.
 * Same util as web-admin — string is the wire format per
 * packages/shared/src/zod/primitives.ts moneySchema, never round-trip
 * through `Number` for storage / accumulation; Intl.NumberFormat for
 * display only is fine.
 */
function formatTHB(value: string): string {
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  return new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'THB',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

// -------------------------------------------------------------------------
// Reusable shell + button styles (mirrors BindPage to keep visual identity)
// -------------------------------------------------------------------------

function Shell({
  title,
  accent,
  children,
}: {
  title: string;
  accent?: 'success' | 'error';
  children: ReactNode;
}) {
  const accentClass =
    accent === 'success'
      ? 'border-line-green/40 bg-line-green/5'
      : accent === 'error'
        ? 'border-red-300 bg-red-50'
        : 'border-gray-200 bg-white';
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-stretch px-4 pt-10 pb-6">
      <section className={`rounded-2xl border p-6 shadow-sm ${accentClass}`}>
        <h1 className="mb-3 text-lg font-semibold">{title}</h1>
        {children}
      </section>
    </main>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-4" aria-label="กำลังโหลด">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700" />
    </div>
  );
}

const btnBase =
  'mt-2 inline-flex w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed';
const btnPrimary = `${btnBase} bg-line-green text-white hover:bg-line-green/90 focus:ring-line-green`;
