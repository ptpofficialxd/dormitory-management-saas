'use client';

import type { AuditLogWire } from '@/queries/audit-log';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

/**
 * Audit log table (Task #120). Client Component because rows are
 * expandable to reveal the full `metadata` JSON — keep it in the SPA so
 * users can drill in/out without a navigation roundtrip.
 *
 * Columns (mobile-first ≥375px):
 *   - timestamp (Bangkok wall-clock, th-TH)
 *   - action (e.g. `signup.success`, `POST /c/.../payments`)
 *   - resource + resourceId (truncated)
 *   - actor (UUID truncated; null = "system" for self-signup / trial.warning)
 *   - expand chevron → reveals JSON-formatted metadata + IP / UA
 *
 * No sorting affordance — server orders by createdAt DESC, no client toggle.
 * Add column-sort if a beta customer asks.
 */

interface AuditLogTableProps {
  items: readonly AuditLogWire[];
}

export function AuditLogTable({ items }: AuditLogTableProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-md border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
        ไม่พบบันทึกกิจกรรมตามตัวกรองที่เลือก
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border">
      <ul className="divide-y divide-border">
        {items.map((row) => (
          <AuditLogRow key={row.id} row={row} />
        ))}
      </ul>
    </div>
  );
}

function AuditLogRow({ row }: { row: AuditLogWire }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="bg-card text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:outline-none"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
          <time
            dateTime={row.createdAt.toISOString()}
            className="shrink-0 font-mono text-xs text-muted-foreground sm:w-44"
          >
            {formatBangkokTimestamp(row.createdAt)}
          </time>
          <span className="truncate font-mono text-xs sm:flex-1">{row.action}</span>
          <span className="shrink-0 text-xs text-muted-foreground sm:w-32 sm:text-right">
            <span className="font-medium text-foreground">{row.resource}</span>
            {row.resourceId ? (
              <span className="ml-1 text-muted-foreground">· {shortId(row.resourceId)}</span>
            ) : null}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground sm:w-24 sm:text-right">
            {row.actorUserId ? shortId(row.actorUserId) : <i>system</i>}
          </span>
        </div>
      </button>
      {open ? (
        <div className="space-y-2 border-t bg-muted/30 px-3 py-2 text-xs">
          <DetailLine label="ID" value={row.id} mono />
          <DetailLine label="Resource ID" value={row.resourceId ?? '—'} mono />
          <DetailLine label="Actor user" value={row.actorUserId ?? 'system (null)'} mono />
          <DetailLine label="IP" value={row.ipAddress ?? '—'} mono />
          <DetailLine
            label="User agent"
            value={row.userAgent ? truncate(row.userAgent, 80) : '—'}
          />
          <div>
            <span className="text-muted-foreground">Metadata</span>
            <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] leading-tight">
              {JSON.stringify(row.metadata, null, 2)}
            </pre>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function DetailLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono break-all' : 'break-words'}>{value}</span>
    </div>
  );
}

/** UUID → first-8-char prefix (enough for visual disambiguation in a list). */
function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function formatBangkokTimestamp(d: Date): string {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}
