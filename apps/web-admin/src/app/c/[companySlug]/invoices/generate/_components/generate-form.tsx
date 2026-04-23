'use client';

import { batchGenerateInvoicesAction } from '@/actions/invoices';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { BatchGenerateInvoicesResultWire, BatchSkipReason } from '@/queries/invoices';
import { CheckCircle2, Loader2, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useMemo, useState, useTransition } from 'react';

/**
 * Batch generate form — Client Component.
 *
 * Two inputs: `period` (rolling 3-month window centred on "now") and
 * `dueDayOfMonth` (1-28; default 5 — most Thai dorms bill on day-5 of
 * the next month). The rest of the BatchGenerateInvoicesInput surface
 * (`propertyId`, `additionalItems`) is left out of MVP — operators run
 * a single property + rely on per-invoice manual edits for one-offs.
 *
 * Result handling:
 * - Stays on the same route after submit (no navigation) so the operator
 *   can read skip reasons + re-run without losing context.
 * - Skip reasons are grouped + counted for at-a-glance triage.
 * - Form re-enables after submit so re-running is one click away.
 */
export function GenerateForm({ companySlug }: { companySlug: string }) {
  const periodOptions = useMemo(() => buildPeriodOptions(), []);
  const [period, setPeriod] = useState(periodOptions[0] ?? '');
  const [dueDayOfMonth, setDueDayOfMonth] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchGenerateInvoicesResultWire | null>(null);
  const [isPending, startTransition] = useTransition();

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await batchGenerateInvoicesAction(companySlug, { period, dueDayOfMonth });
      if (res.ok) {
        setResult(res.result);
      } else {
        setError(res.message);
      }
    });
  };

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="period">รอบบิล (YYYY-MM)</Label>
            <select
              id="period"
              value={period}
              disabled={isPending}
              onChange={(e) => setPeriod(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {periodOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="due-day">วันครบกำหนดของเดือน (1–28)</Label>
            <Input
              id="due-day"
              type="number"
              min={1}
              max={28}
              required
              disabled={isPending}
              value={dueDayOfMonth}
              onChange={(e) => setDueDayOfMonth(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            ระบบจะข้ามสัญญาที่ขาดค่ามิเตอร์น้ำ/ไฟ ของรอบนั้นโดยอัตโนมัติ — แก้ค่ามิเตอร์ก่อนแล้วกด "สร้าง" ใหม่ได้
          </p>
          <Button type="submit" disabled={isPending}>
            {isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-4 w-4" />
            )}
            สร้างใบแจ้งหนี้
          </Button>
        </div>

        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </form>

      {result ? <ResultPanel companySlug={companySlug} period={period} result={result} /> : null}
    </div>
  );
}

function ResultPanel({
  companySlug,
  period,
  result,
}: {
  companySlug: string;
  period: string;
  result: BatchGenerateInvoicesResultWire;
}) {
  const generatedCount = result.generatedInvoiceIds.length;
  const skippedCount = result.skipped.length;

  // Group skipped rows by reason for a compact summary.
  const grouped = result.skipped.reduce<Record<BatchSkipReason, number>>(
    (acc, row) => {
      acc[row.reason] = (acc[row.reason] ?? 0) + 1;
      return acc;
    },
    {} as Record<BatchSkipReason, number>,
  );

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-4">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald-600" />
        <p className="text-sm font-medium">
          สร้างเสร็จ {generatedCount} ใบ
          {skippedCount > 0 ? ` · ข้าม ${skippedCount} ใบ` : ''}
        </p>
      </div>

      {skippedCount > 0 ? (
        <div className="space-y-1 rounded-md border bg-background p-3">
          <p className="text-xs font-medium text-muted-foreground">เหตุผลที่ข้าม</p>
          <ul className="space-y-0.5 text-sm">
            {(Object.entries(grouped) as Array<[BatchSkipReason, number]>).map(
              ([reason, count]) => (
                <li key={reason} className="flex justify-between">
                  <span>{SKIP_REASON_LABEL[reason]}</span>
                  <span className="font-mono text-xs text-muted-foreground">{count} ใบ</span>
                </li>
              ),
            )}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link
            href={`/c/${companySlug}/invoices?period=${encodeURIComponent(period)}&status=draft`}
          >
            ดูบิลที่สร้างใหม่
          </Link>
        </Button>
      </div>
    </div>
  );
}

const SKIP_REASON_LABEL: Record<BatchSkipReason, string> = {
  missing_water_reading: 'ขาดค่ามิเตอร์น้ำของรอบนี้',
  missing_electric_reading: 'ขาดค่ามิเตอร์ไฟของรอบนี้',
  duplicate_invoice: 'มีบิลของรอบนี้อยู่แล้ว (สร้างซ้ำ)',
  inactive_contract: 'สัญญาไม่ได้ใช้งาน',
  no_active_contract: 'ห้องนี้ไม่มีสัญญาในรอบนี้',
};

/**
 * Build a 3-month window of "YYYY-MM": current → 1 forward → 2 forward.
 * Manager typically generates the upcoming month's invoices on day 1-5
 * of the new month, so we surface "near future" rather than past months.
 */
function buildPeriodOptions(): string[] {
  const bkkParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const yr = Number(bkkParts.find((p) => p.type === 'year')?.value ?? '0');
  const mo = Number(bkkParts.find((p) => p.type === 'month')?.value ?? '0');

  const out: string[] = [];
  for (let offset = 0; offset <= 2; offset++) {
    const totalMonths = yr * 12 + (mo - 1) + offset;
    const y = Math.floor(totalMonths / 12);
    const m = (totalMonths % 12) + 1;
    out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
}
