import type { PaymentMethod } from '@dorm/shared/zod';
import { type ChangeEvent, type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useTenantSession } from '../hooks/useTenantSession.js';
import { ApiError } from '../lib/api.js';
import { useInvoiceDetail } from '../queries/invoices.js';
import { useSlipUpload } from '../queries/payments.js';

/**
 * /c/:companySlug/invoices/:id/pay — single-page slip submit flow.
 *
 * Per Task #73 UX choice (single page, camera → preview → submit):
 *   1. Pick file (camera capture OR gallery / files via <input type=file>).
 *   2. Live preview thumbnail (image) or filename pill (PDF).
 *   3. Confirm/edit amount (default = invoice.total) + method (default
 *      = promptpay).
 *   4. Submit → useSlipUpload orchestrates payment create + R2 PUT +
 *      slip register. Disables button + shows step text while running.
 *   5. Success → navigate to /c/:slug/payments/:paymentId (Task #74).
 *
 * Mime + size validation runs client-side BEFORE the upload mutation —
 * server enforces the same bounds (CLAUDE.md §3 #9 + slip schema).
 */

const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
type AcceptedMime = (typeof ACCEPTED_MIME_TYPES)[number];
const MAX_SLIP_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB — matches SLIP_MAX_SIZE_BYTES on server

const METHOD_OPTIONS: ReadonlyArray<{ value: PaymentMethod; label: string }> = [
  { value: 'promptpay', label: 'PromptPay' },
  { value: 'bank_transfer', label: 'โอนผ่านธนาคาร' },
  { value: 'cash', label: 'เงินสด' },
];

export function PayPage() {
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

  return <PayForm token={session.token} companySlug={slug} invoiceId={invoiceId} />;
}

// -------------------------------------------------------------------------
// Form
// -------------------------------------------------------------------------

function PayForm({
  token,
  companySlug,
  invoiceId,
}: {
  token: string;
  companySlug: string;
  invoiceId: string;
}) {
  const navigate = useNavigate();
  const invoiceQ = useInvoiceDetail({ token, invoiceId });
  const upload = useSlipUpload({ token });

  const [file, setFile] = useState<File | null>(null);
  const [amount, setAmount] = useState<string>('');
  const [method, setMethod] = useState<PaymentMethod>('promptpay');
  const [validation, setValidation] = useState<string | null>(null);

  // Seed the amount field with invoice.total once on first invoice load.
  useEffect(() => {
    if (invoiceQ.data && amount === '') {
      setAmount(invoiceQ.data.total);
    }
  }, [invoiceQ.data, amount]);

  // On success → status page (Task #74). For now Task #74's route may not
  // exist yet; the Link / navigate falls to NotFound, then Task #74 fills
  // it in. Caller can also tap "back" to invoice detail to see history.
  useEffect(() => {
    if (upload.isSuccess) {
      const paymentId = upload.data.payment.id;
      navigate(`/c/${companySlug}/payments/${paymentId}`, { replace: true });
    }
  }, [upload.isSuccess, upload.data, navigate, companySlug]);

  if (invoiceQ.isLoading) {
    return (
      <Shell title="กำลังโหลด">
        <Spinner />
      </Shell>
    );
  }

  if (invoiceQ.isError) {
    const isNotFound = invoiceQ.error instanceof ApiError && invoiceQ.error.statusCode === 404;
    return (
      <Shell title={isNotFound ? 'ไม่พบใบแจ้งหนี้' : 'โหลดไม่สำเร็จ'} accent="error">
        <Link to={`/c/${companySlug}/invoices`} className={btnSecondary}>
          กลับไปรายการ
        </Link>
      </Shell>
    );
  }

  const invoice = invoiceQ.data;
  if (!invoice) return null;

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setValidation(null);
    if (!f) {
      setFile(null);
      return;
    }
    if (!ACCEPTED_MIME_TYPES.includes(f.type as AcceptedMime)) {
      setValidation('ไฟล์ต้องเป็น JPG / PNG / WebP / PDF');
      setFile(null);
      return;
    }
    if (f.size > MAX_SLIP_SIZE_BYTES) {
      setValidation(`ไฟล์ใหญ่เกินไป (สูงสุด ${formatMB(MAX_SLIP_SIZE_BYTES)})`);
      setFile(null);
      return;
    }
    setFile(f);
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setValidation(null);
    if (!file) {
      setValidation('กรุณาเลือกไฟล์สลิปก่อน');
      return;
    }
    const amtNum = Number(amount);
    if (!Number.isFinite(amtNum) || amtNum <= 0) {
      setValidation('ยอดต้องเป็นจำนวนเงินที่ถูกต้อง');
      return;
    }
    upload.mutate({ invoiceId: invoice.id, amount, method, file });
  };

  const isPending = upload.isPending;
  const errMsg = upload.isError ? mapUploadError(upload.error) : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-stretch gap-3 px-4 pt-6 pb-6">
      <div>
        <Link
          to={`/c/${companySlug}/invoices/${invoice.id}`}
          className="-ml-1 inline-flex items-center gap-1 text-sm text-gray-500"
        >
          ← กลับไปใบแจ้งหนี้
        </Link>
      </div>

      <header>
        <h1 className="text-xl font-semibold tracking-tight">อัปโหลดสลิปการชำระ</h1>
        <p className="text-xs text-gray-500">
          รอบบิล <span className="font-mono">{invoice.period}</span> · ยอด{' '}
          <span className="font-mono">{formatTHB(invoice.total)}</span>
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        {/* File picker */}
        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <label htmlFor="slip-file" className="block text-sm font-medium">
            ไฟล์สลิป
          </label>
          <p className="mb-2 text-xs text-gray-500">รับ JPG / PNG / WebP / PDF ขนาดไม่เกิน 10 MB</p>
          <input
            id="slip-file"
            type="file"
            accept={ACCEPTED_MIME_TYPES.join(',')}
            // `capture` opens the camera as a first-choice picker on mobile
            // — user can still switch to gallery / files via the picker UI.
            capture="environment"
            disabled={isPending}
            onChange={onPickFile}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-line-green file:px-3 file:py-2 file:text-sm file:font-medium file:text-white"
          />

          {file ? <FilePreview file={file} /> : null}
        </section>

        {/* Amount + method */}
        <section className="space-y-3 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div>
            <label htmlFor="amount" className="block text-sm font-medium">
              ยอดที่ชำระ (บาท)
            </label>
            <input
              id="amount"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              required
              disabled={isPending}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-base focus:border-line-green focus:outline-none focus:ring-1 focus:ring-line-green"
            />
            <p className="mt-1 text-xs text-gray-500">
              ค่าเริ่มต้น = ยอดเต็มของใบแจ้งหนี้ ปรับได้ถ้าชำระบางส่วน
            </p>
          </div>

          <div>
            <span className="block text-sm font-medium">วิธีการชำระ</span>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {METHOD_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={isPending}
                  onClick={() => setMethod(opt.value)}
                  className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                    method === opt.value
                      ? 'border-line-green bg-line-green/10 text-line-green'
                      : 'border-gray-300 bg-white text-gray-700'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Validation + server error */}
        {validation ? (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {validation}
          </p>
        ) : null}
        {errMsg ? (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errMsg}
          </p>
        ) : null}

        {/* Submit */}
        <button
          type="submit"
          disabled={isPending || !file}
          className={isPending || !file ? btnPrimaryDisabled : btnPrimary}
        >
          {isPending ? 'กำลังอัปโหลด…' : 'ส่งสลิป'}
        </button>
      </form>
    </main>
  );
}

// -------------------------------------------------------------------------
// File preview — image thumbnail or PDF placeholder pill
// -------------------------------------------------------------------------

function FilePreview({ file }: { file: File }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Create + revoke the object URL so the browser doesn't leak memory if
  // the user picks multiple files in a row.
  useEffect(() => {
    if (!file.type.startsWith('image/')) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div className="mt-3 space-y-2">
      {previewUrl ? (
        <img
          src={previewUrl}
          alt="ตัวอย่างสลิป"
          className="max-h-72 w-full rounded-md border border-gray-200 object-contain"
        />
      ) : (
        <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-4 text-center text-xs text-gray-600">
          PDF · {file.name}
        </div>
      )}
      <p className="text-xs text-gray-500">
        {file.name} · {formatMB(file.size)}
      </p>
    </div>
  );
}

// -------------------------------------------------------------------------
// Error mapping + formatters
// -------------------------------------------------------------------------

function mapUploadError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'IdempotencyKeyRequired':
        return 'ระบบสร้างคีย์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
      case 'InvalidInvoiceId':
      case 'NotFoundException':
        return 'ไม่พบใบแจ้งหนี้นี้ในบัญชีของคุณ';
      case 'ConflictException':
        return 'ใบแจ้งหนี้นี้ไม่อยู่ในสถานะที่รับชำระได้แล้ว — ลองรีเฟรชหน้าใบแจ้งหนี้';
      case 'BadRequestException':
        return err.message || 'ข้อมูลไม่ถูกต้อง — ลองตรวจสอบไฟล์และยอดอีกครั้ง';
      case 'NetworkError':
        return 'การเชื่อมต่อมีปัญหา กรุณาลองใหม่อีกครั้ง';
      default:
        return err.message || 'อัปโหลดสลิปไม่สำเร็จ';
    }
  }
  return err instanceof Error ? err.message : 'อัปโหลดสลิปไม่สำเร็จ';
}

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

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
const btnPrimaryDisabled = `${btnBase} bg-gray-200 text-gray-500`;
const btnSecondary = `${btnBase} border border-gray-300 bg-white text-gray-900 hover:bg-gray-50`;
