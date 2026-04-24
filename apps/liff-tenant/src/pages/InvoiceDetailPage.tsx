import type {
  InvoiceItemKind,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
} from '@dorm/shared/zod';
import { type ReactNode, useMemo } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useTenantSession } from '../hooks/useTenantSession.js';
import { ApiError } from '../lib/api.js';
import { type InvoiceItemWire, type InvoiceWire, useInvoiceDetail } from '../queries/invoices.js';
import { type PaymentWire, useInvoicePayments } from '../queries/payments.js';

/**
 * /c/:companySlug/invoices/:id — LIFF invoice detail.
 *
 * Three sections stacked top-down for a 375-px viewport:
 *   1. Header card — period, status, total, due date, PromptPay ref
 *   2. Items list  — line items (rent, water, electric, ...) with TH labels
 *   3. Payments    — slips uploaded so far + status (pending / confirmed /
 *                    rejected with reason). Empty state prompts upload.
 *
 * Primary CTA "อัปโหลดสลิปการชำระ" → /c/:slug/invoices/:id/pay (Task #73).
 * Hidden when the invoice is `paid` / `void` (no further action needed).
 *
 * 404 from /me/invoices/:id → cross-tenant probe / stale link → friendly
 * "ไม่พบใบแจ้งหนี้" with back-to-list.
 */
export function InvoiceDetailPage() {
  const { companySlug, id } = useParams<{ companySlug: string; id: string }>();
  const slug = companySlug ?? '';
  const invoiceId = id ?? '';
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
    return <Navigate to={`/c/${slug}/bind`} replace />;
  }

  if (session.status === 'error') {
    return (
      <Shell title="โหลดข้อมูลไม่สำเร็จ" accent="error">
        <p className="text-sm text-gray-600">{session.error}</p>
      </Shell>
    );
  }

  return <DetailView token={session.token} companySlug={slug} invoiceId={invoiceId} />;
}

// -------------------------------------------------------------------------
// Authenticated view — fetches invoice + payment history in parallel
// -------------------------------------------------------------------------

function DetailView({
  token,
  companySlug,
  invoiceId,
}: {
  token: string;
  companySlug: string;
  invoiceId: string;
}) {
  const invoiceQ = useInvoiceDetail({ token, invoiceId });
  const paymentsQ = useInvoicePayments({ token, invoiceId });

  if (invoiceQ.isLoading) {
    return (
      <Shell title="ใบแจ้งหนี้">
        <Spinner />
      </Shell>
    );
  }

  if (invoiceQ.isError) {
    const err = invoiceQ.error;
    const isNotFound = err instanceof ApiError && err.statusCode === 404;
    return (
      <Shell title={isNotFound ? 'ไม่พบใบแจ้งหนี้' : 'โหลดไม่สำเร็จ'} accent="error">
        <p className="mb-3 text-sm text-gray-600">
          {isNotFound ? 'ใบแจ้งหนี้ที่เรียกอาจถูกลบ หรือไม่ใช่ของบัญชีนี้' : (err?.message ?? 'เกิดข้อผิดพลาด')}
        </p>
        <Link to={`/c/${companySlug}/invoices`} className={btnSecondary}>
          กลับไปรายการ
        </Link>
      </Shell>
    );
  }

  const invoice = invoiceQ.data;
  if (!invoice) return null; // unreachable — isLoading/isError guards

  const payments = paymentsQ.data?.items ?? [];
  const canPay = invoice.status !== 'paid' && invoice.status !== 'void';

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-stretch gap-3 px-4 pt-6 pb-6">
      <div>
        <Link
          to={`/c/${companySlug}/invoices`}
          className="-ml-1 inline-flex items-center gap-1 text-sm text-gray-500"
        >
          ← กลับไปรายการ
        </Link>
      </div>

      <InvoiceHeader invoice={invoice} />

      {canPay ? (
        <Link to={`/c/${companySlug}/invoices/${invoice.id}/pay`} className={`${btnPrimary} mt-0`}>
          อัปโหลดสลิปการชำระ
        </Link>
      ) : null}

      <ItemsCard items={invoice.items} />

      <PaymentsCard payments={payments} loading={paymentsQ.isLoading} />
    </main>
  );
}

// -------------------------------------------------------------------------
// Sections
// -------------------------------------------------------------------------

function InvoiceHeader({ invoice }: { invoice: InvoiceWire }) {
  const dueLabel = useMemo(
    () =>
      new Intl.DateTimeFormat('th-TH', {
        timeZone: 'Asia/Bangkok',
        dateStyle: 'medium',
      }).format(invoice.dueDate),
    [invoice.dueDate],
  );
  const issueLabel = useMemo(
    () =>
      new Intl.DateTimeFormat('th-TH', {
        timeZone: 'Asia/Bangkok',
        dateStyle: 'medium',
      }).format(invoice.issueDate),
    [invoice.issueDate],
  );

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500">รอบบิล</p>
          <p className="font-mono text-lg font-semibold">{invoice.period}</p>
        </div>
        <StatusBadge status={invoice.status} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
        <dt className="text-gray-500">ออกบิลเมื่อ</dt>
        <dd className="text-right text-gray-900">{issueLabel}</dd>
        <dt className="text-gray-500">ครบกำหนด</dt>
        <dd className="text-right text-gray-900">{dueLabel}</dd>
        {invoice.promptPayRef ? (
          <>
            <dt className="text-gray-500">PromptPay</dt>
            <dd className="text-right">
              <CopyableRef value={invoice.promptPayRef} />
            </dd>
          </>
        ) : null}
      </dl>

      <div className="mt-4 flex items-baseline justify-between border-t border-gray-100 pt-3">
        <span className="text-sm text-gray-500">ยอดรวม</span>
        <span className="font-mono text-2xl font-semibold text-gray-900">
          {formatTHB(invoice.total)}
        </span>
      </div>
    </section>
  );
}

function ItemsCard({ items }: { items: readonly InvoiceItemWire[] }) {
  if (items.length === 0) {
    return (
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold">รายการในบิล</h2>
        <p className="text-sm text-gray-500">ไม่มีรายการ</p>
      </section>
    );
  }
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold">รายการในบิล</h2>
      <ul className="divide-y divide-gray-100">
        {items.map((it) => (
          <li key={it.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-gray-900">{KIND_LABEL[it.kind]}</p>
              <p className="truncate text-xs text-gray-500">{it.description}</p>
            </div>
            <span className="shrink-0 font-mono text-sm text-gray-900">
              {formatTHB(it.lineTotal)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PaymentsCard({
  payments,
  loading,
}: {
  payments: readonly PaymentWire[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">ประวัติการชำระ</h2>
        <Spinner />
      </section>
    );
  }
  if (payments.length === 0) {
    return (
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold">ประวัติการชำระ</h2>
        <p className="text-sm text-gray-500">ยังไม่ได้อัปโหลดสลิปสำหรับบิลนี้</p>
      </section>
    );
  }

  // Newest first — tenant just uploaded → wants to see the row at the top.
  const sorted = [...payments].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold">ประวัติการชำระ</h2>
      <ul className="divide-y divide-gray-100">
        {sorted.map((p) => (
          <li key={p.id} className="space-y-1 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-gray-500">{formatDateTime(p.createdAt)}</span>
              <PaymentStatusBadge status={p.status} />
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-gray-500">{METHOD_LABEL[p.method]}</span>
              <span className="font-mono text-sm font-semibold text-gray-900">
                {formatTHB(p.amount)}
              </span>
            </div>
            {p.status === 'rejected' && p.rejectionReason ? (
              <p className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-700">
                เหตุผล: {p.rejectionReason}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CopyableRef({ value }: { value: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).catch(() => {
          /* ignore — non-secure-context fallback below */
        });
      }}
      className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-700 active:bg-gray-200"
      title="แตะเพื่อคัดลอก"
    >
      {value}
    </button>
  );
}

// -------------------------------------------------------------------------
// Status / label maps + formatters
// -------------------------------------------------------------------------

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

const PAYMENT_STATUS_CLASS: Record<PaymentStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  confirmed: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-red-100 text-red-800',
};
const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: 'รอตรวจสอบ',
  confirmed: 'ยืนยันแล้ว',
  rejected: 'ปฏิเสธ',
};
function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${PAYMENT_STATUS_CLASS[status]}`}
    >
      {PAYMENT_STATUS_LABEL[status]}
    </span>
  );
}

const METHOD_LABEL: Record<PaymentMethod, string> = {
  promptpay: 'PromptPay',
  cash: 'เงินสด',
  bank_transfer: 'โอนผ่านธนาคาร',
};

const KIND_LABEL: Record<InvoiceItemKind, string> = {
  rent: 'ค่าเช่า',
  water: 'ค่าน้ำ',
  electric: 'ค่าไฟ',
  common_fee: 'ค่าส่วนกลาง',
  late_fee: 'ค่าปรับล่าช้า',
  deposit: 'เงินประกัน',
  other: 'อื่นๆ',
};

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

function formatDateTime(d: Date): string {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

// -------------------------------------------------------------------------
// Reusable shell + button styles (mirrors BindPage / InvoicesPage)
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
const btnSecondary = `${btnBase} border border-gray-300 bg-white text-gray-900 hover:bg-gray-50`;
