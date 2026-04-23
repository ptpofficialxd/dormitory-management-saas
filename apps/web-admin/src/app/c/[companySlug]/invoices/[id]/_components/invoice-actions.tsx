'use client';

import { issueInvoiceAction, voidInvoiceAction } from '@/actions/invoices';
import { Button } from '@/components/ui/button';
import { Can } from '@/lib/rbac';
import type { InvoiceStatus } from '@dorm/shared/zod';
import { Ban, FileCheck, Loader2 } from 'lucide-react';
import { type FormEvent, useState, useTransition } from 'react';

/**
 * Invoice action bar — issue + void buttons with inline reason form.
 *
 * Status-aware enable/disable:
 * - Issue: only valid from `draft`. Other statuses disable the button +
 *   show a tooltip-like hint via title attr.
 * - Void: forbidden from `paid` / `void` (already terminal). Other statuses
 *   open an inline reason form (4–512 chars per shared voidInvoiceInputSchema).
 *
 * RBAC layer:
 * - Issue: <Can action="approve" resource="invoice"> — owner + manager.
 * - Void:  <Can action="update"  resource="invoice"> — owner + manager.
 *
 * Why inline form (vs modal): no shadcn Dialog primitive yet. The collapse
 * pattern avoids adding a portal layer + keeps focus management simple.
 * Could swap to <Dialog> once shadcn-cli is wired up.
 */
export function InvoiceActions({
  companySlug,
  invoiceId,
  status,
}: {
  companySlug: string;
  invoiceId: string;
  status: InvoiceStatus;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState('');

  const canIssue = status === 'draft';
  const canVoid = status !== 'void' && status !== 'paid';

  const handleIssue = () => {
    setError(null);
    startTransition(async () => {
      const res = await issueInvoiceAction(companySlug, invoiceId);
      if (!res.ok) setError(res.message);
      // Success path: revalidatePath in the action triggers a re-render with
      // the new status; nothing to do here.
    });
  };

  const handleVoid = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await voidInvoiceAction(companySlug, invoiceId, reason.trim());
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setVoidOpen(false);
      setReason('');
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Can action="approve" resource="invoice">
          <Button
            type="button"
            size="sm"
            disabled={!canIssue || isPending}
            onClick={handleIssue}
            title={canIssue ? undefined : 'ออกบิลได้เฉพาะใบที่ยังเป็นร่างเท่านั้น'}
          >
            {isPending && canIssue ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <FileCheck className="mr-1 h-4 w-4" />
            )}
            ออกบิล
          </Button>
        </Can>

        <Can action="update" resource="invoice">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canVoid || isPending || voidOpen}
            onClick={() => setVoidOpen(true)}
            title={canVoid ? undefined : 'ใบที่ชำระแล้วหรือถูกยกเลิกแล้วไม่สามารถยกเลิกซ้ำได้'}
          >
            <Ban className="mr-1 h-4 w-4" />
            ยกเลิกใบนี้
          </Button>
        </Can>
      </div>

      {voidOpen ? (
        <form onSubmit={handleVoid} className="space-y-2 rounded-md border bg-card p-3">
          <label htmlFor="void-reason" className="block text-sm font-medium">
            เหตุผลการยกเลิก
          </label>
          <textarea
            id="void-reason"
            value={reason}
            disabled={isPending}
            onChange={(e) => setReason(e.target.value)}
            minLength={4}
            maxLength={512}
            required
            rows={3}
            placeholder="ระบุเหตุผลโดยย่อ (จะบันทึกใน audit log)"
            className="w-full rounded-md border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isPending}
              onClick={() => {
                setVoidOpen(false);
                setReason('');
                setError(null);
              }}
            >
              ยกเลิก
            </Button>
            <Button type="submit" size="sm" variant="destructive" disabled={isPending}>
              {isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              ยืนยันการยกเลิก
            </Button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
