'use client';

import { updateContractAction } from '@/actions/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Can } from '@/lib/rbac';
import type { ContractStatus, ContractWire } from '@/queries/contracts';
import { CheckCircle2, FileText, XCircle } from 'lucide-react';
import { useState, useTransition } from 'react';

/**
 * ContractDetail — Client Component for the contract detail page.
 *
 * State machines:
 *   - `status`: optimistic + revert-on-error pattern (same as Tenants).
 *     Allowed transitions per the shared schema docs:
 *       draft       → active        ("ยืนยันสัญญา" CTA)
 *       active      → ended         ("ครบกำหนด")
 *       active      → terminated    ("ยกเลิกก่อนกำหนด")
 *       draft       → terminated    ("ยกเลิกร่าง")
 *     Anything else is hidden — the API enforces, but UI guides.
 *   - `notes`: inline edit + Save button (debounce-free; admin-typed +
 *     submit-on-blur seems intrusive). Renders read-only until edit clicked.
 *
 * RBAC: status + notes both gated via `<Can action="update" resource="contract">`.
 * Owner / property_manager only — staff don't sign contracts.
 */
export function ContractDetail({
  companySlug,
  contract,
  unitNumber,
  tenantDisplayName,
}: {
  companySlug: string;
  contract: ContractWire;
  unitNumber: string | null;
  tenantDisplayName: string | null;
}) {
  const [status, setStatus] = useState<ContractStatus>(contract.status);
  const [notes, setNotes] = useState<string>(contract.notes ?? '');
  const [editingNotes, setEditingNotes] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const dateFormatter = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
  });
  const moneyFormatter = new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'THB',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const onStatusChange = (next: ContractStatus) => {
    if (next === status) return;
    setServerError(null);
    const previous = status;
    setStatus(next); // optimistic
    startTransition(async () => {
      const result = await updateContractAction(companySlug, contract.id, { status: next });
      if (result && !result.ok) {
        setStatus(previous);
        setServerError(result.message);
      }
    });
  };

  const onSaveNotes = () => {
    setServerError(null);
    const trimmed = notes.trim();
    startTransition(async () => {
      const result = await updateContractAction(companySlug, contract.id, {
        notes: trimmed.length === 0 ? undefined : trimmed,
      });
      if (result && !result.ok) {
        setServerError(result.message);
        return;
      }
      setEditingNotes(false);
    });
  };

  const allowedNextStatuses = transitionsFrom(status);

  return (
    <div className="space-y-4">
      {/* Header card with status pill + key facts */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-0.5">
            <CardTitle className="text-lg">
              {tenantDisplayName ?? '— ไม่ทราบผู้เช่า —'} · ห้อง{' '}
              {unitNumber ?? <span className="text-muted-foreground">ไม่ทราบ</span>}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              สร้างเมื่อ {dateFormatter.format(contract.createdAt)}
            </p>
          </div>
          <StatusPill status={status} pending={isPending} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <DetailRow label="วันเริ่ม">
              {dateFormatter.format(new Date(contract.startDate))}
            </DetailRow>
            <DetailRow label="วันสิ้นสุด">
              {contract.endDate ? (
                dateFormatter.format(new Date(contract.endDate))
              ) : (
                <span className="text-muted-foreground">ไม่กำหนด (เดือน-ต่อ-เดือน)</span>
              )}
            </DetailRow>
            <DetailRow label="ค่าเช่า/เดือน">
              <span className="font-mono">
                {moneyFormatter.format(Number(contract.rentAmount))}
              </span>
            </DetailRow>
            <DetailRow label="เงินประกัน">
              <span className="font-mono text-muted-foreground">
                {moneyFormatter.format(Number(contract.depositAmount))}
              </span>
            </DetailRow>
          </div>

          <DetailRow label="Contract ID">
            <span className="font-mono text-xs text-muted-foreground">{contract.id}</span>
          </DetailRow>
        </CardContent>
      </Card>

      {/* Activate CTA — biggest, most prominent for the draft → active step */}
      {status === 'draft' ? (
        <Can action="update" resource="contract">
          <Card className="border-emerald-500/40 bg-emerald-500/5">
            <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">สัญญายังเป็นร่าง — บิลจะยังไม่ออก</p>
                <p className="text-xs text-muted-foreground">
                  กด "ยืนยันสัญญา" เพื่อเปลี่ยนเป็น "ใช้งาน" — รอบบิลถัดไประบบจะออกใบแจ้งหนี้ให้อัตโนมัติ
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={isPending}
                onClick={() => onStatusChange('active')}
              >
                <CheckCircle2 className="mr-1 h-4 w-4" />
                ยืนยันสัญญา
              </Button>
            </CardContent>
          </Card>
        </Can>
      ) : null}

      {/* Status transitions card — only shows if there are valid next states */}
      {allowedNextStatuses.length > 0 ? (
        <Can action="update" resource="contract">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">เปลี่ยนสถานะ</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                การเปลี่ยนสถานะถูกบันทึกใน audit log อัตโนมัติ
              </p>
              <div className="flex flex-wrap gap-2">
                {allowedNextStatuses.map((next) => (
                  <Button
                    key={next}
                    type="button"
                    variant={next === 'terminated' ? 'destructive' : 'outline'}
                    size="sm"
                    disabled={isPending}
                    onClick={() => onStatusChange(next)}
                  >
                    {next === 'terminated' ? (
                      <XCircle className="mr-1 h-3 w-3" />
                    ) : (
                      <FileText className="mr-1 h-3 w-3" />
                    )}
                    {transitionLabel(next)}
                  </Button>
                ))}
              </div>
              {serverError ? (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive"
                >
                  {serverError}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </Can>
      ) : null}

      {/* Notes — inline edit */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">บันทึก</CardTitle>
          <Can action="update" resource="contract">
            {editingNotes ? null : (
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditingNotes(true)}>
                แก้ไข
              </Button>
            )}
          </Can>
        </CardHeader>
        <CardContent className="space-y-2">
          {editingNotes ? (
            <>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                disabled={isPending}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="(ว่าง)"
              />
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  onClick={() => {
                    setNotes(contract.notes ?? '');
                    setEditingNotes(false);
                  }}
                >
                  ยกเลิก
                </Button>
                <Button type="button" size="sm" disabled={isPending} onClick={onSaveNotes}>
                  {isPending ? 'กำลังบันทึก…' : 'บันทึก'}
                </Button>
              </div>
            </>
          ) : (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {notes.length > 0 ? notes : <em>(ว่าง)</em>}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// State machine helpers (UI-only mirror of the documented transitions)
// ---------------------------------------------------------------------------

/**
 * Allowed status transitions FROM each state. Mirrors the Zod schema
 * docstring; the API is the source of truth (it'll 409 on invalid moves).
 * Keeping a UI mirror prevents the buttons from showing dead-ends.
 */
function transitionsFrom(status: ContractStatus): ContractStatus[] {
  switch (status) {
    case 'draft':
      // "Activate" is its own prominent CTA above; here we only offer the
      // "discard draft" path so the buttons here aren't redundant.
      return ['terminated'];
    case 'active':
      return ['ended', 'terminated'];
    case 'ended':
    case 'terminated':
      // Terminal states — no transitions out. Re-create a new contract.
      return [];
  }
}

function transitionLabel(status: ContractStatus): string {
  switch (status) {
    case 'draft':
      return 'กลับเป็นร่าง';
    case 'active':
      return 'ยืนยันสัญญา';
    case 'ended':
      return 'ครบกำหนด';
    case 'terminated':
      return 'ยกเลิกก่อนกำหนด';
  }
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function StatusPill({ status, pending }: { status: ContractStatus; pending: boolean }) {
  const styles: Record<ContractStatus, string> = {
    draft: 'bg-muted text-muted-foreground',
    active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    ended: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
    terminated: 'bg-destructive/15 text-destructive',
  };
  const labels: Record<ContractStatus, string> = {
    draft: 'ร่าง',
    active: 'ใช้งาน',
    ended: 'ครบกำหนด',
    terminated: 'ยกเลิก',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]} ${pending ? 'opacity-50' : ''}`}
    >
      {labels[status]}
      {pending ? '…' : null}
    </span>
  );
}
