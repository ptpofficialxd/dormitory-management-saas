import type { PaymentMethod, PaymentStatus } from '@dorm/shared/zod';
import { type ReactNode, useMemo } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useTenantSession } from '../hooks/useTenantSession.js';
import { ApiError } from '../lib/api.js';
import {
  type PaymentWire,
  usePaymentDetail,
  useSlipForPayment,
  useSlipViewUrl,
} from '../queries/payments.js';

/**
 * /c/:companySlug/payments/:id — post-upload status page.
 *
 * Lands here after PayPage submits successfully. Three states drive the UI:
 *
 *   pending   → amber banner "รอตรวจสอบ" + slip thumbnail + back-to-bill
 *   confirmed → green banner "ยืนยันแล้ว" + slip thumbnail + back-to-bill
 *   rejected  → red banner with reason + "อัปโหลดสลิปใหม่" CTA back to
 *                /c/:slug/invoices/:invoiceId/pay (creates a new payment;
 *                rejected rows are terminal — no in-place edit)
 *
 * Auto-refresh:
 *   - Polling every 30s while status === 'pending' (TanStack Query
 *     refetchInterval) so admin confirm/reject lands without a manual
 *     reload.
 *   - Refetch on window focus (TanStack default) so an admin OK while
 *     the user has the LIFF backgrounded shows up on resume.
 */
export function PaymentStatusPage() {
  const { companySlug, id } = useParams<{ companySlug: string; id: string }>();
  const slug = companySlug ?? '';
  const paymentId = id ?? '';
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
        <p className="text-sm text-gray-600">กรุณาเปิดลิงก์นี้จากแอป LINE บนมือถือเท่านั้น</p>
      </Shell>
    );
  }
  if (session.status === 'needs_bind') {
    return <Navigate to={`/c/${slug}/bind`} replace />;
  }
  if (session.status === 'error') {
    return (
      <Shell title="เกิดข้อผิดพลาด" accent="error">
        <p className="text-sm text-gray-600">{session.error}</p>
      </Shell>
    );
  }

  return <StatusView token={session.token} companySlug={slug} paymentId={paymentId} />;
}

// -------------------------------------------------------------------------
// Authenticated view
// -------------------------------------------------------------------------

function StatusView({
  token,
  companySlug,
  paymentId,
}: {
  token: string;
  companySlug: string;
  paymentId: string;
}) {
  const paymentQ = usePaymentDetail({ token, paymentId });

  if (paymentQ.isLoading) {
    return (
      <Shell title="กำลังโหลด">
        <Spinner />
      </Shell>
    );
  }

  if (paymentQ.isError) {
    const isNotFound = paymentQ.error instanceof ApiError && paymentQ.error.statusCode === 404;
    return (
      <Shell title={isNotFound ? 'ไม่พบรายการชำระ' : 'โหลดไม่สำเร็จ'} accent="error">
        <p className="mb-3 text-sm text-gray-600">
          {isNotFound
            ? 'รายการชำระที่เรียกอาจถูกลบ หรือไม่ใช่ของบัญชีนี้'
            : (paymentQ.error?.message ?? 'เกิดข้อผิดพลาด')}
        </p>
        <Link to={`/c/${companySlug}/invoices`} className={btnSecondary}>
          กลับไปรายการบิล
        </Link>
      </Shell>
    );
  }

  const payment = paymentQ.data;
  if (!payment) return null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-stretch gap-3 px-4 pt-6 pb-6">
      <div>
        <Link
          to={`/c/${companySlug}/invoices/${payment.invoiceId}`}
          className="-ml-1 inline-flex items-center gap-1 text-sm text-gray-500"
        >
          ← กลับไปใบแจ้งหนี้
        </Link>
      </div>

      <StatusBanner payment={payment} />

      <PaymentMetaCard payment={payment} />

      <SlipPreviewCard token={token} paymentId={payment.id} />

      <ActionFooter payment={payment} companySlug={companySlug} />
    </main>
  );
}

// -------------------------------------------------------------------------
// Big-status banner (top)
// -------------------------------------------------------------------------

function StatusBanner({ payment }: { payment: PaymentWire }) {
  if (payment.status === 'pending') {
    return (
      <section className="rounded-2xl border border-amber-300 bg-amber-50 p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="h-3 w-3 animate-pulse rounded-full bg-amber-500" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold text-amber-900">รอตรวจสอบ</p>
            <p className="text-xs text-amber-800">
              ผู้ดูแลหอจะตรวจสอบสลิปและยืนยันให้ภายใน 24 ชม. ระบบจะอัปเดตหน้านี้อัตโนมัติ
            </p>
          </div>
        </div>
      </section>
    );
  }
  if (payment.status === 'confirmed') {
    return (
      <section className="rounded-2xl border border-emerald-300 bg-emerald-50 p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="text-emerald-600" aria-hidden>
            ✓
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold text-emerald-900">ยืนยันแล้ว</p>
            <p className="text-xs text-emerald-800">ผู้ดูแลหอยืนยันการชำระของคุณเรียบร้อย ขอบคุณครับ/ค่ะ</p>
          </div>
        </div>
      </section>
    );
  }
  // rejected
  return (
    <section className="rounded-2xl border border-red-300 bg-red-50 p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="text-red-600" aria-hidden>
          ✗
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-red-900">ปฏิเสธ</p>
          {payment.rejectionReason ? (
            <p className="mt-0.5 text-sm text-red-800">เหตุผล: {payment.rejectionReason}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// -------------------------------------------------------------------------
// Payment metadata card
// -------------------------------------------------------------------------

function PaymentMetaCard({ payment }: { payment: PaymentWire }) {
  const submittedLabel = useMemo(() => formatDateTime(payment.createdAt), [payment.createdAt]);
  const confirmedLabel = useMemo(
    () => (payment.confirmedAt ? formatDateTime(payment.confirmedAt) : null),
    [payment.confirmedAt],
  );

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold">รายละเอียดการชำระ</h2>
      <dl className="grid grid-cols-2 gap-y-2 text-sm">
        <dt className="text-gray-500">ยอด</dt>
        <dd className="text-right font-mono text-base font-semibold text-gray-900">
          {formatTHB(payment.amount)}
        </dd>
        <dt className="text-gray-500">วิธี</dt>
        <dd className="text-right text-gray-900">{METHOD_LABEL[payment.method]}</dd>
        <dt className="text-gray-500">ส่งเมื่อ</dt>
        <dd className="text-right text-xs text-gray-700">{submittedLabel}</dd>
        {confirmedLabel ? (
          <>
            <dt className="text-gray-500">ยืนยันเมื่อ</dt>
            <dd className="text-right text-xs text-gray-700">{confirmedLabel}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

// -------------------------------------------------------------------------
// Slip preview — 2-hop fetch (slip metadata → signed view URL)
// -------------------------------------------------------------------------

function SlipPreviewCard({ token, paymentId }: { token: string; paymentId: string }) {
  const slipQ = useSlipForPayment({ token, paymentId });
  const slipId = slipQ.data?.id;
  const viewUrlQ = useSlipViewUrl({ token, slipId: slipId ?? '' });

  if (slipQ.isLoading || (slipId && viewUrlQ.isLoading)) {
    return (
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">สลิปที่อัปโหลด</h2>
        <Spinner />
      </section>
    );
  }

  if (slipQ.isError) {
    const isNotFound = slipQ.error instanceof ApiError && slipQ.error.statusCode === 404;
    return (
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold">สลิปที่อัปโหลด</h2>
        <p className="text-xs text-gray-500">
          {isNotFound ? 'ยังไม่ได้อัปโหลดสลิปสำหรับรายการนี้' : 'ไม่สามารถโหลดสลิปได้'}
        </p>
      </section>
    );
  }

  if (viewUrlQ.isError || !viewUrlQ.data) {
    return (
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold">สลิปที่อัปโหลด</h2>
        <p className="text-xs text-gray-500">ไม่สามารถสร้างลิงก์ดูสลิปได้ในขณะนี้</p>
      </section>
    );
  }

  const url = viewUrlQ.data.url;
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold">สลิปที่อัปโหลด</h2>
      <div className="overflow-hidden rounded-md border border-gray-200 bg-gray-50">
        {/*
          Plain <img> rather than next/image-style optimisation: signed
          R2 URLs have unique hashed query strings + expire fast (~5 min);
          any image CDN cache layer would serve stale 4xx-ed assets.
        */}
        <img src={url} alt="สลิปการชำระ" className="max-h-96 w-full object-contain" />
      </div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-2 inline-flex items-center gap-1 text-xs text-gray-500 underline-offset-2 hover:underline"
      >
        เปิดในแท็บใหม่ (ลิงก์หมดอายุภายใน 5 นาที)
      </a>
    </section>
  );
}

// -------------------------------------------------------------------------
// Action footer — context-aware CTA
// -------------------------------------------------------------------------

function ActionFooter({
  payment,
  companySlug,
}: {
  payment: PaymentWire;
  companySlug: string;
}) {
  if (payment.status === 'rejected') {
    return (
      <Link
        to={`/c/${companySlug}/invoices/${payment.invoiceId}/pay`}
        className={`${btnPrimary} mt-0`}
      >
        อัปโหลดสลิปใหม่
      </Link>
    );
  }
  // pending / confirmed — primary action is going back to the bill
  return (
    <Link to={`/c/${companySlug}/invoices/${payment.invoiceId}`} className={`${btnSecondary} mt-0`}>
      ดูใบแจ้งหนี้
    </Link>
  );
}

// -------------------------------------------------------------------------
// Label maps + formatters
// -------------------------------------------------------------------------

const METHOD_LABEL: Record<PaymentMethod, string> = {
  promptpay: 'PromptPay',
  cash: 'เงินสด',
  bank_transfer: 'โอนผ่านธนาคาร',
};

// status enum is used for narrowing only; no UI badge map needed because
// the StatusBanner renders the whole panel per state.
type _PaymentStatusUsed = PaymentStatus;

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
