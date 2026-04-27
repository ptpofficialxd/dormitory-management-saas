'use client';

import { getMaintenancePhotoViewUrlAction, updateMaintenanceAction } from '@/actions/maintenance';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Can } from '@/lib/rbac';
import type { MaintenanceRequestWire, MaintenanceStatus } from '@/queries/maintenance';
import { Image as ImageIcon, Loader2 } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';

/**
 * MaintenanceDetail — admin ticket detail + interactive controls.
 *
 * UI sections:
 *   1. Header — title + status badge + priority + reporter / unit
 *   2. Description (read-only)
 *   3. Photos — lazy-loads signed URLs via /maintenance/:id/photos/:key/view-url
 *   4. Assignee — dropdown (admin users) or read-only label (staff role)
 *   5. Status transitions — buttons for valid next states from current status
 *   6. Resolution note — textarea (required when transitioning to
 *      resolved / cancelled)
 *
 * RBAC: writeable controls wrapped in <Can resource="maintenance_ticket"
 * action="update"> — read-only view for users without permission.
 *
 * State machine guard duplicated client-side for UX (disable invalid buttons)
 * but the server is authoritative — server returns 409 InvalidStatusTransition
 * if a stale UI tries to push a forbidden flip.
 */

const STATUS_BADGE: Record<MaintenanceStatus, { label: string; className: string }> = {
  open: { label: 'รอรับเรื่อง', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  in_progress: {
    label: 'กำลังดำเนินการ',
    className: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  },
  resolved: {
    label: 'ซ่อมแล้ว',
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  },
  closed: { label: 'ปิดงาน', className: 'bg-muted text-muted-foreground' },
  cancelled: { label: 'ตีตก', className: 'bg-destructive/15 text-destructive' },
};

const PRIORITY_LABEL: Record<MaintenanceRequestWire['priority'], string> = {
  low: 'ต่ำ',
  normal: 'ปกติ',
  high: 'สูง',
  urgent: 'ด่วน',
};

const CATEGORY_LABEL: Record<MaintenanceRequestWire['category'], string> = {
  plumbing: 'ประปา',
  electrical: 'ไฟฟ้า',
  aircon: 'แอร์',
  appliance: 'เครื่องใช้',
  furniture: 'เฟอร์นิเจอร์',
  structural: 'โครงสร้าง',
  internet: 'อินเทอร์เน็ต',
  other: 'อื่น ๆ',
};

/**
 * Mirrors `STATUS_TRANSITIONS` in apps/api/src/modules/maintenance/
 * maintenance.service.ts. Keep in sync — server is authoritative but
 * showing dead buttons is bad UX.
 */
const TRANSITIONS_FROM: Record<MaintenanceStatus, readonly MaintenanceStatus[]> = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['resolved', 'cancelled'],
  resolved: ['in_progress', 'closed', 'cancelled'],
  closed: [],
  cancelled: [],
};

interface AssignableUser {
  id: string;
  displayName: string;
  email: string;
}

interface MaintenanceDetailProps {
  companySlug: string;
  ticket: MaintenanceRequestWire;
  tenantName: string;
  unitLabel: string;
  /** Empty array when caller lacks `staff_user:read` (e.g. staff role). */
  assignableUsers: AssignableUser[];
}

export function MaintenanceDetail({
  companySlug,
  ticket: initialTicket,
  tenantName,
  unitLabel,
  assignableUsers,
}: MaintenanceDetailProps) {
  const [ticket, setTicket] = useState(initialTicket);
  const [resolutionNote, setResolutionNote] = useState(initialTicket.resolutionNote ?? '');
  const [assignedToUserId, setAssignedToUserId] = useState<string | null>(
    initialTicket.assignedToUserId,
  );
  const [serverError, setServerError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [isPending, startTransition] = useTransition();

  const status = STATUS_BADGE[ticket.status];
  const allowedTransitions = TRANSITIONS_FROM[ticket.status];
  const isTerminal = allowedTransitions.length === 0;

  const submit = (patch: Parameters<typeof updateMaintenanceAction>[2]) => {
    setServerError(null);
    setSavedAt(null);
    startTransition(async () => {
      const result = await updateMaintenanceAction(companySlug, ticket.id, patch);
      if (!result.ok) {
        setServerError(result.message);
        return;
      }
      setTicket(result.ticket);
      setResolutionNote(result.ticket.resolutionNote ?? '');
      setAssignedToUserId(result.ticket.assignedToUserId);
      setSavedAt(new Date());
    });
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-base">{ticket.title}</CardTitle>
              <p className="text-xs text-muted-foreground">
                {unitLabel} · {tenantName}
              </p>
            </div>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${status.className}`}
            >
              {status.label}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            <Field label="หมวด" value={CATEGORY_LABEL[ticket.category]} />
            <Field label="ความเร่งด่วน" value={PRIORITY_LABEL[ticket.priority]} />
            <Field label="แจ้งเมื่อ" value={formatDateTime(ticket.createdAt)} />
            <Field
              label="ซ่อมเสร็จ"
              value={ticket.resolvedAt ? formatDateTime(ticket.resolvedAt) : '—'}
            />
          </div>

          <div>
            <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              รายละเอียดที่แจ้ง
            </p>
            <p className="whitespace-pre-line rounded-md border bg-muted/20 p-3 text-sm">
              {ticket.description}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Photos */}
      {ticket.photoR2Keys.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">รูปประกอบ ({ticket.photoR2Keys.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {ticket.photoR2Keys.map((key) => (
                <PhotoThumb
                  key={key}
                  companySlug={companySlug}
                  ticketId={ticket.id}
                  photoKey={key}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Admin actions */}
      <Can
        action="update"
        resource="maintenance_ticket"
        fallback={
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">การจัดการ</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">คุณไม่มีสิทธิ์อัปเดตรายการนี้ — ดูสถานะอย่างเดียว</p>
            </CardContent>
          </Card>
        }
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">การจัดการ</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Assignee */}
            {assignableUsers.length > 0 ? (
              <div className="space-y-1">
                <Label htmlFor="assignee" className="text-xs">
                  ผู้รับผิดชอบ
                </Label>
                <div className="flex gap-2">
                  <select
                    id="assignee"
                    value={assignedToUserId ?? ''}
                    onChange={(e) => setAssignedToUserId(e.target.value || null)}
                    disabled={isPending}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="">— ยังไม่กำหนด —</option>
                    {assignableUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName} ({u.email})
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isPending || assignedToUserId === ticket.assignedToUserId}
                    onClick={() => submit({ assignedToUserId })}
                  >
                    {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'บันทึก'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">ผู้รับผิดชอบ</p>
                <p className="text-sm">
                  {ticket.assignedToUserId ?? '— ยังไม่กำหนด — (ติดต่อเจ้าของหอเพื่อมอบหมาย)'}
                </p>
              </div>
            )}

            {/* Resolution note */}
            <div className="space-y-1">
              <Label htmlFor="note" className="text-xs">
                เหตุผล / รายงานการซ่อม{' '}
                <span className="text-muted-foreground">(จำเป็นสำหรับ "ซ่อมแล้ว" และ "ตีตก")</span>
              </Label>
              <textarea
                id="note"
                rows={3}
                value={resolutionNote}
                onChange={(e) => setResolutionNote(e.target.value)}
                disabled={isPending}
                placeholder="เช่น เปลี่ยนก๊อกใหม่ + ทดสอบแล้ว"
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isPending || resolutionNote === (ticket.resolutionNote ?? '')}
                  onClick={() => submit({ resolutionNote })}
                >
                  บันทึกหมายเหตุ
                </Button>
              </div>
            </div>

            {/* Status transitions */}
            {!isTerminal ? (
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">เปลี่ยนสถานะ</p>
                <div className="flex flex-wrap gap-2">
                  {allowedTransitions.map((next) => (
                    <Button
                      key={next}
                      type="button"
                      size="sm"
                      variant={next === 'cancelled' ? 'destructive' : 'default'}
                      disabled={isPending}
                      onClick={() => submit({ status: next, resolutionNote })}
                    >
                      → {STATUS_BADGE[next].label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
                สถานะ "{status.label}" เป็นปลายทาง (terminal) — ไม่สามารถเปลี่ยนต่อได้
              </p>
            )}

            {serverError ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive"
              >
                {serverError}
              </p>
            ) : null}

            {savedAt ? (
              <output className="block rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-700 dark:text-emerald-400">
                ✓ บันทึกแล้วเมื่อ{' '}
                {new Intl.DateTimeFormat('th-TH', {
                  timeZone: 'Asia/Bangkok',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                }).format(savedAt)}
              </output>
            ) : null}
          </CardContent>
        </Card>
      </Can>
    </div>
  );
}

// -------------------------------------------------------------------------
// Sub-components
// -------------------------------------------------------------------------

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p>{value}</p>
    </div>
  );
}

/**
 * PhotoThumb — fetches a signed view URL on mount, renders an <img>.
 * Signed URL TTL ≤ 5 min (CLAUDE.md §3.9); we don't refresh — page reload
 * gets a fresh URL. Could refresh on focus in Phase 2 if dwell time
 * exceeds TTL becomes an actual issue.
 */
function PhotoThumb({
  companySlug,
  ticketId,
  photoKey,
}: {
  companySlug: string;
  ticketId: string;
  photoKey: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetchUrl() {
      // Server Action — sends httpOnly cookie automatically; returns null
      // if auth or upstream API fails. We render a fallback in either case.
      const data = await getMaintenancePhotoViewUrlAction(companySlug, ticketId, photoKey);
      if (cancelled) return;
      if (!data) {
        setError(true);
        return;
      }
      setUrl(data.url);
    }
    void fetchUrl();
    return () => {
      cancelled = true;
    };
  }, [companySlug, ticketId, photoKey]);

  if (error) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-md border bg-muted/20 text-[10px] text-muted-foreground">
        โหลดรูปไม่สำเร็จ
      </div>
    );
  }
  if (!url) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-md border bg-muted/20">
        <ImageIcon className="h-6 w-6 text-muted-foreground" />
      </div>
    );
  }
  // Plain <img> instead of next/image — signed URL changes per session
  // (TTL ≤ 5 min) so static optimisation + CDN caching wouldn't apply
  // anyway. Server proxies the bytes via R2; no CDN layer in the path.
  return (
    <img
      src={url}
      alt="รูปประกอบแจ้งซ่อม"
      className="aspect-square w-full rounded-md border object-cover"
    />
  );
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
