'use client';

import { updateTenantAction } from '@/actions/tenants';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatNationalId, formatPhone, maskNationalId, maskPhone } from '@/lib/pii';
import { Can } from '@/lib/rbac';
import type { TenantStatus, TenantWire } from '@/queries/tenants';
import { Eye, EyeOff } from 'lucide-react';
import { useState, useTransition } from 'react';

/**
 * TenantDetail — Client Component for the detail page.
 *
 * Two state machines live here:
 *   1. PII reveal toggle (`revealed: boolean`) — UI-only state. The data
 *      is already in memory client-side; reveal just flips the formatter
 *      from masked → full. No round-trip. Phase 2 wishlist: route reveal
 *      through an audit-logged endpoint so PDPA / forensics can answer
 *      "who looked at this PII when".
 *   2. Status change dropdown — `updateTenantAction` patches the row,
 *      revalidatePath() on the server side refreshes both list + detail.
 *
 * RBAC:
 *   - PII reveal: any admin role with `read:tenant_user` (everyone who
 *     can see this page) — gating it tighter would be friction since the
 *     wire payload already carries the data. Phase 2 audit + role check.
 *   - Status change: gated via `<Can action="update" resource="tenant_user">`.
 *     Owner / property_manager / staff per the matrix.
 */
export function TenantDetail({
  companySlug,
  tenant,
}: {
  companySlug: string;
  tenant: TenantWire;
}) {
  const [revealed, setRevealed] = useState(false);
  const [status, setStatus] = useState<TenantStatus>(tenant.status);
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const dateFormatter = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const onStatusChange = (next: TenantStatus) => {
    if (next === status) return;
    setServerError(null);
    const previous = status;
    setStatus(next); // optimistic
    startTransition(async () => {
      const result = await updateTenantAction(companySlug, tenant.id, { status: next });
      if (result && !result.ok) {
        // Revert on failure so the dropdown shows truth, not the wishful click.
        setStatus(previous);
        setServerError(result.message);
      }
    });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-0.5">
            <CardTitle className="text-lg">{tenant.displayName}</CardTitle>
            <p className="text-xs text-muted-foreground">
              เพิ่มเมื่อ {dateFormatter.format(tenant.createdAt)}
            </p>
          </div>
          <StatusPill status={status} pending={isPending} />
        </CardHeader>
        <CardContent className="space-y-4">
          <DetailRow label="ID">
            <span className="font-mono text-xs text-muted-foreground">{tenant.id}</span>
          </DetailRow>

          <DetailRow label="LINE">
            {tenant.lineUserId ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-line-green/15 px-2 py-0.5 text-xs text-line-green">
                  <span className="h-1.5 w-1.5 rounded-full bg-line-green" />
                  ผูกแล้ว
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {tenant.lineUserId.slice(0, 12)}…
                </span>
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">ยังไม่ผูก LINE</span>
            )}
          </DetailRow>

          <PiiRow
            label="โทรศัพท์"
            value={tenant.phone}
            revealed={revealed}
            mask={maskPhone}
            format={formatPhone}
          />
          <PiiRow
            label="เลขบัตรประชาชน"
            value={tenant.nationalId}
            revealed={revealed}
            mask={maskNationalId}
            format={formatNationalId}
          />

          <div className="flex justify-end pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRevealed((r) => !r)}
              className="text-xs"
            >
              {revealed ? (
                <>
                  <EyeOff className="mr-1 h-3 w-3" />
                  ซ่อนข้อมูล
                </>
              ) : (
                <>
                  <Eye className="mr-1 h-3 w-3" />
                  แสดงข้อมูล PII
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Can action="update" resource="tenant_user">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">เปลี่ยนสถานะ</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              ระบบไม่รองรับการลบผู้เช่าโดยตรง (ผูกกับสัญญา + ใบแจ้งหนี้) — ใช้สถานะ "ย้ายออก" เพื่อปิดการใช้งาน หรือ
              "ระงับ" หากมีปัญหาทุจริต
            </p>
            <div className="flex flex-wrap gap-2">
              <StatusOption
                value="active"
                label="พักอยู่"
                current={status}
                pending={isPending}
                onClick={onStatusChange}
              />
              <StatusOption
                value="moved_out"
                label="ย้ายออก"
                current={status}
                pending={isPending}
                onClick={onStatusChange}
              />
              <StatusOption
                value="blocked"
                label="ระงับ"
                current={status}
                pending={isPending}
                onClick={onStatusChange}
              />
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function PiiRow({
  label,
  value,
  revealed,
  mask,
  format,
}: {
  label: string;
  value: string | null | undefined;
  revealed: boolean;
  mask: (v: string | null | undefined) => string;
  format: (v: string | null | undefined) => string;
}) {
  return (
    <DetailRow label={label}>
      <span className="font-mono text-sm">{revealed ? format(value) : mask(value)}</span>
    </DetailRow>
  );
}

function StatusPill({ status, pending }: { status: TenantStatus; pending: boolean }) {
  const labels: Record<TenantStatus, string> = {
    active: 'พักอยู่',
    moved_out: 'ย้ายออก',
    blocked: 'ระงับ',
  };
  const styles: Record<TenantStatus, string> = {
    active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    moved_out: 'bg-muted text-muted-foreground',
    blocked: 'bg-destructive/15 text-destructive',
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

function StatusOption({
  value,
  label,
  current,
  pending,
  onClick,
}: {
  value: TenantStatus;
  label: string;
  current: TenantStatus;
  pending: boolean;
  onClick: (v: TenantStatus) => void;
}) {
  const active = value === current;
  return (
    <Button
      type="button"
      variant={active ? 'default' : 'outline'}
      size="sm"
      disabled={pending || active}
      onClick={() => onClick(value)}
    >
      {label}
    </Button>
  );
}
