'use client';

import {
  confirmPaymentAction,
  getSlipViewUrlAction,
  rejectPaymentAction,
} from '@/actions/payments';
import { Button } from '@/components/ui/button';
import { Can, useRole } from '@/lib/rbac';
import type { PaymentWire } from '@/queries/payments';
import type { PaymentMethod, PaymentStatus } from '@dorm/shared/zod';
import { Check, ChevronDown, ChevronUp, ExternalLink, FileWarning, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState, useTransition } from 'react';

/**
 * Payment row — Client Component with expand/collapse + lazy slip fetch.
 *
 * Lazy strategy: the signed slip URL is minted ONLY when the operator
 * expands the row. URL TTL is ~5 min per CLAUDE.md §3 #9 — we do NOT
 * cache it across collapse/re-expand; clicking expand again re-mints.
 *
 * Action gating:
 * - Approve / Reject buttons require @Perm('approve','payment') on the
 *   API. UI mirrors via <Can action="approve" resource="payment">.
 * - Buttons are also disabled when status !== 'pending' since confirming
 *   or rejecting an already-decided payment is a no-op (and the API
 *   would 409 anyway).
 */
export function PaymentRow({
  payment,
  companySlug,
}: {
  payment: PaymentWire;
  companySlug: string;
}) {
  const { can } = useRole();
  const [expanded, setExpanded] = useState(false);
  const [slipUrl, setSlipUrl] = useState<string | null>(null);
  const [slipError, setSlipError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();

  const isPendingStatus = payment.status === 'pending';
  const canApprove = can('approve', 'payment') && isPendingStatus;

  const onExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (!next) {
      // Collapsing — drop the URL so a re-expand re-mints (URL may have expired).
      setSlipUrl(null);
      setSlipError(null);
      setRejectOpen(false);
      setReason('');
      return;
    }
    // Expanding — fetch the slip URL only if the operator can read slips.
    if (!can('read', 'slip')) return;
    startTransition(async () => {
      const res = await getSlipViewUrlAction(companySlug, payment.id);
      if (res.ok) {
        setSlipUrl(res.url);
      } else {
        setSlipError(res.message);
      }
    });
  };

  const handleApprove = () => {
    setActionError(null);
    startTransition(async () => {
      const res = await confirmPaymentAction(companySlug, payment.id);
      if (!res.ok) setActionError(res.message);
    });
  };

  const handleReject = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setActionError(null);
    startTransition(async () => {
      const res = await rejectPaymentAction(companySlug, payment.id, reason.trim());
      if (!res.ok) {
        setActionError(res.message);
        return;
      }
      setRejectOpen(false);
      setReason('');
    });
  };

  const dateTimeFormatter = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <div className="px-4 py-3">
      {/* Summary row — always visible. */}
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-3 text-left hover:bg-muted/30"
        aria-expanded={expanded}
      >
        <div className="grid flex-1 grid-cols-[auto_1fr_auto] items-center gap-3 sm:grid-cols-5">
          <div className="text-xs text-muted-foreground sm:col-span-1">
            {dateTimeFormatter.format(payment.createdAt)}
          </div>
          <div className="text-xs sm:col-span-1">
            <div className="font-medium">ผู้เช่า {payment.tenantId.slice(0, 8)}…</div>
            <div className="text-muted-foreground">บิล {payment.invoiceId.slice(0, 8)}…</div>
          </div>
          <div className="text-right font-mono text-sm sm:col-span-1 sm:text-left">
            {formatTHB(payment.amount)}
          </div>
          <div className="hidden sm:col-span-1 sm:block text-xs">
            {METHOD_LABEL[payment.method]}
          </div>
          <div className="hidden sm:col-span-1 sm:block">
            <PaymentStatusBadge status={payment.status} />
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {/* Status badge for narrow viewports — separate row to keep summary tidy. */}
      <div className="mt-1 sm:hidden">
        <PaymentStatusBadge status={payment.status} />
      </div>

      {/* Expanded panel. */}
      {expanded ? (
        <div className="mt-3 space-y-3 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Button asChild variant="ghost" size="sm">
              <Link href={`/c/${companySlug}/invoices/${payment.invoiceId}`}>
                <ExternalLink className="mr-1 h-3 w-3" />
                ดูใบแจ้งหนี้
              </Link>
            </Button>
          </div>

          <SlipViewer
            isLoading={isPending && slipUrl === null && slipError === null}
            url={slipUrl}
            error={slipError}
            canRead={can('read', 'slip')}
          />

          <Can action="approve" resource="payment">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={!canApprove || isPending}
                  onClick={handleApprove}
                  title={canApprove ? undefined : 'ยืนยันได้เฉพาะรายการที่ยังรอตรวจสอบเท่านั้น'}
                >
                  {isPending ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="mr-1 h-4 w-4" />
                  )}
                  ยืนยันการชำระ
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!isPendingStatus || isPending || rejectOpen}
                  onClick={() => setRejectOpen(true)}
                >
                  <X className="mr-1 h-4 w-4" />
                  ปฏิเสธ
                </Button>
              </div>

              {rejectOpen ? (
                <form
                  onSubmit={handleReject}
                  className="space-y-2 rounded-md border bg-muted/30 p-3"
                >
                  <label
                    htmlFor={`reject-reason-${payment.id}`}
                    className="block text-sm font-medium"
                  >
                    เหตุผลการปฏิเสธ
                  </label>
                  <textarea
                    id={`reject-reason-${payment.id}`}
                    value={reason}
                    disabled={isPending}
                    onChange={(e) => setReason(e.target.value)}
                    minLength={1}
                    maxLength={512}
                    required
                    rows={3}
                    placeholder="เช่น: ยอดสลิปไม่ตรงกับบิล / รูปไม่ชัด"
                    className="w-full rounded-md border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isPending}
                      onClick={() => {
                        setRejectOpen(false);
                        setReason('');
                        setActionError(null);
                      }}
                    >
                      ยกเลิก
                    </Button>
                    <Button type="submit" size="sm" variant="destructive" disabled={isPending}>
                      {isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                      ยืนยันการปฏิเสธ
                    </Button>
                  </div>
                </form>
              ) : null}
            </div>
          </Can>

          {actionError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {actionError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SlipViewer({
  isLoading,
  url,
  error,
  canRead,
}: {
  isLoading: boolean;
  url: string | null;
  error: string | null;
  canRead: boolean;
}) {
  if (!canRead) {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
        คุณไม่มีสิทธิ์ดูสลิป
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        กำลังโหลดสลิป…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        <FileWarning className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{error}</span>
      </div>
    );
  }

  if (!url) return null;

  // Render <img> first (covers JPEG/PNG/WebP — the dominant case for slips
  // from LIFF tenants). For PDFs the <img> shows a broken-icon — the
  // "Open in a new tab" link gives the operator a working escape hatch.
  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md border bg-muted/30">
        {/*
          Plain <img> rather than next/image: signed R2 URLs have unique
          hashed query strings (can't allowlist in remotePatterns) and
          they expire ~5 min — Next's optimization layer would cache and
          serve stale 4xx-ed assets.
        */}
        <img src={url} alt="สลิปการชำระ" className="max-h-[480px] w-full object-contain" />
      </div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
      >
        <ExternalLink className="h-3 w-3" />
        เปิดในแท็บใหม่ (URL หมดอายุภายใน 5 นาที)
      </a>
    </div>
  );
}

const METHOD_LABEL: Record<PaymentMethod, string> = {
  promptpay: 'PromptPay',
  cash: 'เงินสด',
  bank_transfer: 'โอนผ่านธนาคาร',
};

const PAYMENT_STATUS_CLASS: Record<PaymentStatus, string> = {
  pending: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  confirmed: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  rejected: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
};

const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: 'รอตรวจสอบ',
  confirmed: 'ยืนยันแล้ว',
  rejected: 'ปฏิเสธ',
};

function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${PAYMENT_STATUS_CLASS[status]}`}
    >
      {PAYMENT_STATUS_LABEL[status]}
    </span>
  );
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
