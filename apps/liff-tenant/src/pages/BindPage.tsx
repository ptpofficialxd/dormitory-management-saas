import { type ReactNode, useEffect, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useLiff } from '../hooks/useLiff.js';
import { ApiError } from '../lib/api.js';
import {
  type TenantInvitePreview,
  usePeekInvite,
  useRedeemInvite,
} from '../queries/tenant-invite.js';

/**
 * /c/:companySlug/bind?code=XXXX-XXXX
 *
 * Single-screen bind flow:
 *
 *   1. mount     → kick off LIFF init + peek (parallel; both finish before render)
 *   2. preview   → show redacted tenant info + confirm button
 *   3. confirm   → fetch LINE idToken from LIFF SDK + POST /redeem
 *   4. terminal  → success (auto-close after 3s) | error (manual retry / contact admin)
 *
 * The `companySlug` path param is unused on the wire (the invite code already
 * locates the tenant + company on the server) — we keep it in the URL so:
 *   - LIFF endpoint URLs stay path-based per CLAUDE.md §3 rule #5
 *   - admin can sanity-check the company in the link before sharing
 */
export function BindPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  const [searchParams] = useSearchParams();
  const code = searchParams.get('code') ?? '';

  const liff = useLiff();
  const peek = usePeekInvite();
  const redeem = useRedeemInvite();

  // Auto-fire peek as soon as the code is present. We don't wait for LIFF
  // init — peek is public and gives the user instant feedback. LIFF init
  // runs in parallel and gates only the redeem button.
  // biome-ignore lint/correctness/useExhaustiveDependencies: peek.mutate is stable across renders (TanStack Query guarantee); we want to refire only when `code` changes.
  useEffect(() => {
    if (code && peek.status === 'idle') {
      peek.mutate({ code });
    }
  }, [code]);

  // Auto-close the LIFF window 3 seconds after a successful redeem.
  useEffect(() => {
    if (redeem.status !== 'success') return;
    if (liff.status !== 'ready') return;
    const t = setTimeout(() => liff.closeWindow(), 3_000);
    return () => clearTimeout(t);
  }, [redeem.status, liff]);

  const onConfirm = () => {
    if (liff.status !== 'ready') return;
    const idToken = liff.getIdToken();
    if (!idToken) {
      // User opened the LIFF without going through the LINE login flow —
      // shouldn't happen inside the LINE in-app browser but guard anyway.
      console.warn('[bind] LIFF idToken missing; cannot redeem');
      return;
    }
    redeem.mutate({ code, lineIdToken: idToken });
  };

  // ----- guard: missing code in URL -----
  if (!code) {
    return (
      <Shell title="ลิงก์ไม่ถูกต้อง">
        <p className="text-sm text-gray-600">ลิงก์นี้ไม่มีรหัสยืนยัน กรุณาเปิดลิงก์ที่ได้รับจากผู้ดูแลหอพักอีกครั้ง</p>
      </Shell>
    );
  }

  // ----- terminal: redeem succeeded -----
  if (redeem.isSuccess) {
    return (
      <Shell title="ผูกบัญชีสำเร็จ" accent="success">
        <p className="text-sm text-gray-600">
          คุณสามารถใช้ LINE บัญชีนี้รับแจ้งเตือนค่าเช่า, ใบแจ้งหนี้, และส่งสลิปได้แล้ว
        </p>
        <p className="mt-4 text-xs text-gray-400">หน้าต่างจะปิดอัตโนมัติใน 3 วินาที…</p>
      </Shell>
    );
  }

  // ----- terminal: redeem failed -----
  if (redeem.isError) {
    return (
      <Shell title="ผูกบัญชีไม่สำเร็จ" accent="error">
        <p className="text-sm text-gray-700">{describeRedeemError(redeem.error)}</p>
        {canRetryRedeem(redeem.error) ? (
          <button type="button" onClick={() => redeem.reset()} className={btnSecondary}>
            ลองอีกครั้ง
          </button>
        ) : null}
      </Shell>
    );
  }

  // ----- transient: LIFF or peek loading -----
  if (peek.isPending || peek.status === 'idle') {
    return (
      <Shell title="กำลังตรวจสอบลิงก์…">
        <Spinner />
      </Shell>
    );
  }

  if (peek.isError) {
    return (
      <Shell title="ไม่พบลิงก์" accent="error">
        <p className="text-sm text-gray-700">{describePeekError(peek.error)}</p>
      </Shell>
    );
  }

  // TanStack mutation result types don't narrow `data` via `isSuccess`, so
  // re-check explicitly. Branches above guarantee we only reach here on success.
  if (!peek.data) return null;

  // ----- happy path: peek succeeded — show preview + confirm -----
  return (
    <Shell title="ยืนยันการผูกบัญชี">
      <PreviewCard preview={peek.data} companySlug={companySlug ?? ''} />
      <LiffGate liff={liff}>
        <button
          type="button"
          onClick={onConfirm}
          disabled={redeem.isPending}
          className={btnPrimary}
        >
          {redeem.isPending ? 'กำลังยืนยัน…' : 'ยืนยันและผูกบัญชี'}
        </button>
      </LiffGate>
      <p className="mt-3 text-xs text-gray-400">การยืนยันจะผูกบัญชี LINE ของคุณกับห้องนี้อย่างถาวร</p>
    </Shell>
  );
}

// -------------------------------------------------------------------------
// Subcomponents
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

function PreviewCard({
  preview,
  companySlug,
}: {
  preview: TenantInvitePreview;
  companySlug: string;
}) {
  const expiresAtLocal = useMemo(
    () =>
      new Intl.DateTimeFormat('th-TH', {
        timeZone: 'Asia/Bangkok',
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(preview.expiresAt),
    [preview.expiresAt],
  );
  return (
    <dl className="mb-5 space-y-2 text-sm">
      <Row label="หอพัก" value={companySlug || '—'} />
      <Row label="อาคาร" value={preview.propertyName ?? '—'} />
      <Row label="ห้อง" value={preview.unitNumber ?? '—'} />
      <Row label="ผู้เช่า" value={preview.tenantDisplayHint} />
      <Row label="หมดอายุ" value={expiresAtLocal} />
    </dl>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-gray-100 pb-1.5 last:border-b-0">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-medium text-gray-900">{value}</dd>
    </div>
  );
}

function LiffGate({
  liff,
  children,
}: {
  liff: ReturnType<typeof useLiff>;
  children: ReactNode;
}) {
  if (liff.status === 'ready') return <>{children}</>;
  if (liff.status === 'loading') {
    return (
      <button type="button" disabled className={btnPrimaryDisabled}>
        กำลังเชื่อมต่อ LINE…
      </button>
    );
  }
  if (liff.status === 'not_in_client') {
    return (
      <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-800">
        กรุณาเปิดลิงก์นี้ในแอป LINE — เปิดผ่านเบราว์เซอร์ปกติจะไม่สามารถยืนยันตัวตนได้
      </p>
    );
  }
  return (
    <p className="rounded-md bg-red-50 p-3 text-xs text-red-700">
      ไม่สามารถเชื่อมต่อ LINE ได้ ({liff.error.message}) — กรุณาปิดและเปิดลิงก์ใหม่
    </p>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-6">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-600" />
    </div>
  );
}

// -------------------------------------------------------------------------
// Error → Thai copy mappers
// -------------------------------------------------------------------------

function describePeekError(err: unknown): string {
  if (!(err instanceof ApiError)) return 'เกิดข้อผิดพลาดที่ไม่รู้จัก กรุณาลองใหม่อีกครั้ง';
  switch (err.code) {
    case 'TenantInviteNotFound':
    case 'NotFoundException':
      return 'ไม่พบรหัสยืนยัน กรุณาตรวจสอบลิงก์อีกครั้ง';
    case 'TenantInviteExpired':
    case 'TenantInviteNotPending':
    case 'GoneException':
      return 'ลิงก์นี้หมดอายุหรือถูกยกเลิกแล้ว กรุณาขอลิงก์ใหม่จากผู้ดูแล';
    case 'NetworkError':
      return 'การเชื่อมต่อมีปัญหา กรุณาลองใหม่อีกครั้ง';
    default:
      return err.message || 'ตรวจสอบลิงก์ไม่สำเร็จ';
  }
}

function describeRedeemError(err: unknown): string {
  if (!(err instanceof ApiError)) return 'ผูกบัญชีไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
  switch (err.code) {
    case 'INVALID_LINE_ID_TOKEN':
    case 'UnauthorizedException':
      return 'การยืนยันตัวตนกับ LINE ล้มเหลว กรุณาปิดและเปิดลิงก์ใหม่อีกครั้ง';
    case 'BIND_CONFLICT':
      return 'บัญชี LINE นี้ถูกผูกกับห้องอื่นอยู่แล้ว กรุณาติดต่อผู้ดูแลหอพักเพื่อยกเลิกการผูกเดิมก่อน';
    case 'TenantInviteRaceLost':
    case 'ConflictException':
      return 'มีการใช้งานรหัสนี้พร้อมกัน กรุณาขอรหัสใหม่จากผู้ดูแล';
    case 'TenantInviteNotPending':
    case 'TenantInviteExpired':
    case 'GoneException':
      return 'ลิงก์หมดอายุระหว่างยืนยัน กรุณาขอลิงก์ใหม่';
    case 'TenantInviteNotFound':
    case 'NotFoundException':
      return 'ไม่พบรหัสยืนยัน กรุณาตรวจสอบลิงก์';
    case 'NetworkError':
      return 'การเชื่อมต่อมีปัญหา กรุณาลองใหม่อีกครั้ง';
    default:
      return err.message || 'ผูกบัญชีไม่สำเร็จ';
  }
}

/** Only allow retry when the failure is transient (network) or recoverable. */
function canRetryRedeem(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  switch (err.code) {
    case 'NetworkError':
    case 'INVALID_LINE_ID_TOKEN':
    case 'UnauthorizedException':
      return true;
    default:
      return false;
  }
}

// -------------------------------------------------------------------------
// Tailwind class helpers (kept inline so we don't pull in shadcn/ui yet)
// -------------------------------------------------------------------------

const btnBase =
  'mt-2 inline-flex w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed';
const btnPrimary = `${btnBase} bg-line-green text-white hover:bg-line-green/90 focus:ring-line-green`;
const btnPrimaryDisabled = `${btnBase} bg-gray-200 text-gray-500`;
const btnSecondary = `${btnBase} border border-gray-300 bg-white text-gray-900 hover:bg-gray-50`;
