'use client';

import { Button } from '@/components/ui/button';
import type { InvoiceStatus } from '@dorm/shared/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useTransition } from 'react';

/**
 * Invoice filter bar — Client Component.
 *
 * State source-of-truth = URL searchParams (so links shareable + the page
 * can be a Server Component for fast first-paint). On change we push a new
 * URL via the router; the parent Server Component re-fetches with the new
 * params during the Next.js navigation.
 *
 * Period options:
 * - 6 months back to 1 month forward (rolling window centred on "now").
 * - "ทั้งหมด" omits the param entirely so the API returns all periods.
 *
 * Status options:
 * - All 6 InvoiceStatus values from the shared schema (we DON'T import the
 *   enum runtime to avoid bundling Zod into the client; just hard-code the
 *   labels since the matrix rarely changes).
 */

interface InvoiceFiltersProps {
  companySlug: string;
  currentPeriod?: string;
  currentStatus?: string;
}

const STATUS_OPTIONS: ReadonlyArray<{ value: InvoiceStatus; label: string }> = [
  { value: 'draft', label: 'ร่าง' },
  { value: 'issued', label: 'ออกบิลแล้ว' },
  { value: 'partially_paid', label: 'ชำระบางส่วน' },
  { value: 'paid', label: 'ชำระแล้ว' },
  { value: 'void', label: 'ยกเลิก' },
  { value: 'overdue', label: 'เกินกำหนด' },
];

export function InvoiceFilters({ companySlug, currentPeriod, currentStatus }: InvoiceFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // Build period dropdown options once per render (cheap; avoids hydration drift
  // from re-running new Date() during SSR vs. client mount).
  const periodOptions = useMemo(() => buildPeriodOptions(), []);

  const updateParam = (key: 'period' | 'status', value: string) => {
    const next = new URLSearchParams(searchParams?.toString() ?? '');
    if (value === '') {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    // Reset cursor when a filter changes — old cursor is bound to the
    // previous filter set on the server side.
    next.delete('cursor');
    const qs = next.toString();
    startTransition(() => {
      router.push(`/c/${companySlug}/invoices${qs ? `?${qs}` : ''}`);
    });
  };

  const reset = () => {
    startTransition(() => {
      router.push(`/c/${companySlug}/invoices`);
    });
  };

  const hasFilters = Boolean(currentPeriod || currentStatus);

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border bg-card p-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="period-filter" className="text-xs font-medium text-muted-foreground">
          รอบบิล
        </label>
        <select
          id="period-filter"
          value={currentPeriod ?? ''}
          disabled={isPending}
          onChange={(e) => updateParam('period', e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">ทั้งหมด</option>
          {periodOptions.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="status-filter" className="text-xs font-medium text-muted-foreground">
          สถานะ
        </label>
        <select
          id="status-filter"
          value={currentStatus ?? ''}
          disabled={isPending}
          onChange={(e) => updateParam('status', e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">ทั้งหมด</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {hasFilters ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={reset}
          className="ml-auto"
        >
          ล้างตัวกรอง
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Build a rolling 8-month window of "YYYY-MM" period strings:
 * 6 months back → current → 1 month forward. Bangkok timezone.
 */
function buildPeriodOptions(): string[] {
  const now = new Date();
  // Anchor on Bangkok local time so a request at 00:30 UTC (07:30 BKK)
  // already shows the new month if the operator is browsing past midnight.
  const bkkParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const yr = Number(bkkParts.find((p) => p.type === 'year')?.value ?? '0');
  const mo = Number(bkkParts.find((p) => p.type === 'month')?.value ?? '0');

  const out: string[] = [];
  // forward 1 → current → back 6  (newest first for natural reading order)
  for (let offset = 1; offset >= -6; offset--) {
    const totalMonths = yr * 12 + (mo - 1) + offset;
    const y = Math.floor(totalMonths / 12);
    const m = (totalMonths % 12) + 1;
    out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
}
