'use client';

import { Button } from '@/components/ui/button';
import type { PaymentStatus } from '@dorm/shared/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

/**
 * Status filter for the slip review queue. URL-driven state — same
 * pattern as InvoiceFilters.
 *
 * "ทั้งหมด" sets the param to empty string (instead of dropping it) so
 * the Server Component can distinguish "explicit all-statuses" from
 * "no filter chosen yet" (the latter defaults to `pending`).
 */

interface PaymentStatusFilterProps {
  companySlug: string;
  currentStatus: string;
}

const STATUS_OPTIONS: ReadonlyArray<{ value: PaymentStatus | ''; label: string }> = [
  { value: 'pending', label: 'รอตรวจสอบ' },
  { value: 'confirmed', label: 'ยืนยันแล้ว' },
  { value: 'rejected', label: 'ปฏิเสธ' },
  { value: '', label: 'ทั้งหมด' },
];

export function PaymentStatusFilter({ companySlug, currentStatus }: PaymentStatusFilterProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const setStatus = (value: string) => {
    const next = new URLSearchParams(searchParams?.toString() ?? '');
    next.set('status', value);
    next.delete('cursor');
    startTransition(() => {
      router.push(`/c/${companySlug}/payments?${next.toString()}`);
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-3">
      <span className="text-xs font-medium text-muted-foreground">สถานะ:</span>
      {STATUS_OPTIONS.map((opt) => (
        <Button
          key={opt.value || 'all'}
          type="button"
          size="sm"
          variant={currentStatus === opt.value ? 'default' : 'outline'}
          disabled={isPending}
          onClick={() => setStatus(opt.value)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}
