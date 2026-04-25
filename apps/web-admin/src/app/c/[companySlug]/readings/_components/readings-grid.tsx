'use client';

import { createReadingAction, updateReadingAction } from '@/actions/readings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Can } from '@/lib/rbac';
import { Droplet, Loader2, Save, Zap } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

/**
 * ReadingsGrid — Client Component for the per-period meter input UI.
 *
 * State model:
 *   - `rows: Map<meterId, RowState>` — one entry per visible meter; initial
 *     value seeded from the `readings` prop (existing reading → 'saved'
 *     state, otherwise 'empty').
 *   - Each save dispatches a Server Action (NOT TanStack mutation) to keep
 *     consistency with the rest of admin (Tenants/Contracts/Settings forms
 *     all use Server Actions). React 19's useTransition tracks pending state
 *     so the input can show a spinner without per-row useState boilerplate.
 *
 * The grid intentionally does NOT optimistically update — the consumption
 * calculation is server-side (Decimal math, not JS Number) and we want the
 * displayed consumption to match exactly what the invoice will use. Worst
 * case: 200ms round-trip per save.
 *
 * Filter chips: ทั้งหมด / ยังไม่กรอก / กรอกแล้ว — common quick filters when
 * the operator is mid-walk and wants to see "what's left to do".
 */

export type GridProperty = { id: string; name: string };
export type GridUnit = {
  id: string;
  propertyId: string;
  unitNumber: string;
  floor: number;
  status: 'vacant' | 'occupied' | 'maintenance' | 'reserved';
};
export type GridMeter = {
  id: string;
  unitId: string;
  kind: 'water' | 'electric';
  unitOfMeasure: string;
  ratePerUnit: string;
};
export type GridReading = {
  id: string;
  meterId: string;
  period: string;
  valueCurrent: string;
  valuePrevious: string;
  consumption: string;
  photoKey: string | null;
  readAt: string;
};

type RowFilter = 'all' | 'pending' | 'done';

type RowState = {
  /** Current input value (string for parse-on-submit, no Number coercion). */
  inputValue: string;
  /** Last-saved reading (if any). null until first save in this session OR if no prior reading. */
  saved: GridReading | null;
  /** UI status. */
  status: 'idle' | 'saving' | 'saved' | 'error';
  /** Last error message to render under the input. */
  error: string | null;
};

interface ReadingsGridProps {
  companySlug: string;
  period: string;
  activePropertyId: string | null;
  properties: GridProperty[];
  units: GridUnit[];
  meters: GridMeter[];
  readings: GridReading[];
}

export function ReadingsGrid({
  companySlug,
  period,
  activePropertyId,
  properties,
  units,
  meters,
  readings,
}: ReadingsGridProps) {
  const router = useRouter();
  const [filter, setFilter] = useState<RowFilter>('all');

  // Lookup tables. Recomputed only when props change — units/meters arrive from
  // a Server Component fetch, so this only re-runs on route navigation.
  const unitById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const readingByMeterId = useMemo(() => new Map(readings.map((r) => [r.meterId, r])), [readings]);

  // Sort: by floor asc, then unitNumber asc, then meter kind (water before
  // electric so the visual order matches the typical bill layout).
  const orderedMeters = useMemo(() => {
    return [...meters].sort((a, b) => {
      const ua = unitById.get(a.unitId);
      const ub = unitById.get(b.unitId);
      if (!ua || !ub) return 0;
      if (ua.floor !== ub.floor) return ua.floor - ub.floor;
      const numCmp = ua.unitNumber.localeCompare(ub.unitNumber, 'en', { numeric: true });
      if (numCmp !== 0) return numCmp;
      // water (0) before electric (1) — alphabetical happens to match
      return a.kind.localeCompare(b.kind);
    });
  }, [meters, unitById]);

  // Initial row state from the existing readings prop. Re-keyed only when the
  // prop identity changes (i.e. Server Component re-fetches after revalidate).
  const [rows, setRows] = useState<Map<string, RowState>>(() => {
    const initial = new Map<string, RowState>();
    for (const meter of meters) {
      const existing = readingByMeterId.get(meter.id) ?? null;
      initial.set(meter.id, {
        inputValue: existing ? existing.valueCurrent : '',
        saved: existing,
        status: existing ? 'saved' : 'idle',
        error: null,
      });
    }
    return initial;
  });

  const updateRow = (meterId: string, patch: Partial<RowState>) => {
    setRows((prev) => {
      const next = new Map(prev);
      const current = next.get(meterId) ?? {
        inputValue: '',
        saved: null,
        status: 'idle',
        error: null,
      };
      next.set(meterId, { ...current, ...patch });
      return next;
    });
  };

  // Period & property navigation — push to URL so the Server Component re-fetches.
  // Using router.push (not router.replace) so back-button takes the operator
  // to the previous period — matches expectations from invoices generate flow.
  const handlePeriodChange = (nextPeriod: string) => {
    const params = new URLSearchParams();
    params.set('period', nextPeriod);
    if (activePropertyId) params.set('propertyId', activePropertyId);
    router.push(`/c/${companySlug}/readings?${params.toString()}`);
  };

  const handlePropertyChange = (nextPropertyId: string) => {
    const params = new URLSearchParams();
    params.set('period', period);
    if (nextPropertyId) params.set('propertyId', nextPropertyId);
    router.push(`/c/${companySlug}/readings?${params.toString()}`);
  };

  const visibleMeters = orderedMeters.filter((m) => {
    const row = rows.get(m.id);
    if (!row) return true;
    if (filter === 'pending') return row.status !== 'saved';
    if (filter === 'done') return row.status === 'saved';
    return true;
  });

  const totalCount = orderedMeters.length;
  const doneCount = Array.from(rows.values()).filter((r) => r.status === 'saved').length;

  return (
    <div className="space-y-4">
      <FilterBar
        period={period}
        properties={properties}
        activePropertyId={activePropertyId}
        filter={filter}
        totalCount={totalCount}
        doneCount={doneCount}
        onPeriodChange={handlePeriodChange}
        onPropertyChange={handlePropertyChange}
        onFilterChange={setFilter}
      />

      {visibleMeters.length === 0 ? (
        <p className="rounded-md border bg-muted/30 p-4 text-center text-sm text-muted-foreground">
          {filter === 'pending'
            ? '🎉 กรอกครบทุกมิเตอร์แล้ว'
            : filter === 'done'
              ? 'ยังไม่มีมิเตอร์ที่กรอกค่าในรอบนี้'
              : 'ไม่มีมิเตอร์ในขอบเขตที่เลือก'}
        </p>
      ) : (
        <Can
          action="create"
          resource="meter_reading"
          fallback={
            <p className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              คุณไม่มีสิทธิ์บันทึกค่ามิเตอร์ — เฉพาะเจ้าของหอ / property manager / staff เท่านั้น
            </p>
          }
        >
          <div className="overflow-hidden rounded-md border">
            {/* Desktop: table layout. Mobile: card layout (≤md). */}
            <table className="hidden w-full border-collapse text-sm md:table">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">ห้อง</th>
                  <th className="px-3 py-2 text-left font-medium">มิเตอร์</th>
                  <th className="px-3 py-2 text-right font-medium">ค่าก่อนหน้า</th>
                  <th className="px-3 py-2 text-right font-medium">ค่าปัจจุบัน</th>
                  <th className="px-3 py-2 text-right font-medium">ใช้ไป</th>
                  <th className="px-3 py-2 text-right font-medium">บันทึก</th>
                </tr>
              </thead>
              <tbody>
                {visibleMeters.map((meter) => {
                  const unit = unitById.get(meter.unitId);
                  const row = rows.get(meter.id) ?? {
                    inputValue: '',
                    saved: null,
                    status: 'idle' as const,
                    error: null,
                  };
                  if (!unit) return null;
                  return (
                    <ReadingRowDesktop
                      key={meter.id}
                      companySlug={companySlug}
                      period={period}
                      meter={meter}
                      unit={unit}
                      row={row}
                      onPatch={(p) => updateRow(meter.id, p)}
                    />
                  );
                })}
              </tbody>
            </table>

            {/* Mobile cards */}
            <div className="divide-y md:hidden">
              {visibleMeters.map((meter) => {
                const unit = unitById.get(meter.unitId);
                const row = rows.get(meter.id) ?? {
                  inputValue: '',
                  saved: null,
                  status: 'idle' as const,
                  error: null,
                };
                if (!unit) return null;
                return (
                  <ReadingRowMobile
                    key={meter.id}
                    companySlug={companySlug}
                    period={period}
                    meter={meter}
                    unit={unit}
                    row={row}
                    onPatch={(p) => updateRow(meter.id, p)}
                  />
                );
              })}
            </div>
          </div>
        </Can>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------
// Filter bar
// -------------------------------------------------------------------------

function FilterBar({
  period,
  properties,
  activePropertyId,
  filter,
  totalCount,
  doneCount,
  onPeriodChange,
  onPropertyChange,
  onFilterChange,
}: {
  period: string;
  properties: GridProperty[];
  activePropertyId: string | null;
  filter: RowFilter;
  totalCount: number;
  doneCount: number;
  onPeriodChange: (p: string) => void;
  onPropertyChange: (id: string) => void;
  onFilterChange: (f: RowFilter) => void;
}) {
  return (
    <div className="space-y-3 rounded-md border bg-card p-3">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="period" className="text-xs">
            รอบบิล (YYYY-MM)
          </Label>
          <Input
            id="period"
            type="month"
            value={period}
            onChange={(e) => {
              if (e.target.value) onPeriodChange(e.target.value);
            }}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="property" className="text-xs">
            อาคาร
          </Label>
          <select
            id="property"
            value={activePropertyId ?? ''}
            onChange={(e) => onPropertyChange(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">ทุกอาคาร</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col justify-end">
          <p className="text-xs text-muted-foreground">
            ความคืบหน้า: <span className="font-medium text-foreground">{doneCount}</span> /{' '}
            {totalCount} มิเตอร์
          </p>
          {/* Decorative bar — the "X / Y มิเตอร์" counter above is the
              authoritative a11y signal for screen readers, so we mark this
              purely visual element aria-hidden. Adding role="progressbar"
              would require focusability (Biome useFocusableInteractive),
              which doesn't fit a non-interactive readout. */}
          <div aria-hidden="true" className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{
                width: totalCount === 0 ? '0%' : `${Math.round((doneCount / totalCount) * 100)}%`,
              }}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        {(
          [
            { value: 'all', label: 'ทั้งหมด' },
            { value: 'pending', label: 'ยังไม่กรอก' },
            { value: 'done', label: 'กรอกแล้ว' },
          ] as { value: RowFilter; label: string }[]
        ).map((chip) => {
          const isActive = chip.value === filter;
          return (
            <button
              key={chip.value}
              type="button"
              onClick={() => onFilterChange(chip.value)}
              className={
                isActive
                  ? 'rounded-full border border-primary bg-primary px-3 py-1 font-medium text-primary-foreground'
                  : 'rounded-full border bg-background px-3 py-1 text-muted-foreground hover:bg-muted'
              }
            >
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------
// Per-row components
// -------------------------------------------------------------------------

/**
 * Internal hook — owns the save handler for a single row. Shared by desktop +
 * mobile renderers so we don't duplicate the action call / error mapping.
 */
function useRowSave(
  companySlug: string,
  period: string,
  meterId: string,
  row: RowState,
  onPatch: (p: Partial<RowState>) => void,
) {
  const [isPending, startTransition] = useTransition();

  const save = () => {
    if (!row.inputValue.trim()) {
      onPatch({ status: 'error', error: 'กรอกค่ามิเตอร์ก่อนบันทึก' });
      return;
    }
    onPatch({ status: 'saving', error: null });

    startTransition(async () => {
      // PATCH if we already have a saved reading; POST otherwise.
      const result = row.saved
        ? await updateReadingAction(companySlug, row.saved.id, {
            valueCurrent: row.inputValue.trim(),
          })
        : await createReadingAction(companySlug, {
            meterId,
            period,
            valueCurrent: row.inputValue.trim(),
          });

      if (!result.ok) {
        onPatch({ status: 'error', error: result.message });
        return;
      }
      onPatch({
        status: 'saved',
        error: null,
        saved: result.reading,
        // Sync the input back to the canonical server-side string in case
        // the user had a leading "+" or trailing space the regex tolerated.
        inputValue: result.reading.valueCurrent,
      });
    });
  };

  return { save, busy: isPending || row.status === 'saving' };
}

function ReadingRowDesktop({
  companySlug,
  period,
  meter,
  unit,
  row,
  onPatch,
}: {
  companySlug: string;
  period: string;
  meter: GridMeter;
  unit: GridUnit;
  row: RowState;
  onPatch: (p: Partial<RowState>) => void;
}) {
  const { save, busy } = useRowSave(companySlug, period, meter.id, row, onPatch);
  const KindIcon = meter.kind === 'water' ? Droplet : Zap;
  const kindLabel = meter.kind === 'water' ? 'น้ำ' : 'ไฟ';
  const kindColor = meter.kind === 'water' ? 'text-sky-600' : 'text-amber-600';

  // Live consumption preview while typing — purely informational; the
  // authoritative value comes from the server response after save.
  const previewConsumption = computeConsumptionPreview(row);

  return (
    <tr className="border-t hover:bg-muted/20">
      <td className="px-3 py-2">
        <div className="font-medium">{unit.unitNumber}</div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          ชั้น {unit.floor}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className={`flex items-center gap-1.5 text-xs ${kindColor}`}>
          <KindIcon className="h-3.5 w-3.5" />
          <span className="font-medium">{kindLabel}</span>
          <span className="text-muted-foreground">({meter.unitOfMeasure})</span>
        </div>
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
        {row.saved ? row.saved.valuePrevious : '—'}
      </td>
      <td className="px-3 py-2 text-right">
        <Input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          placeholder="0.00"
          value={row.inputValue}
          disabled={busy}
          onChange={(e) =>
            onPatch({
              inputValue: e.target.value,
              status: row.status === 'saved' ? 'idle' : row.status,
            })
          }
          className="ml-auto w-28 text-right font-mono"
          aria-invalid={row.status === 'error' ? 'true' : undefined}
        />
        {row.error ? (
          <p className="mt-1 text-right text-[11px] text-destructive">{row.error}</p>
        ) : null}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs">
        {row.status === 'saved' && row.saved ? (
          <span className="font-medium">{row.saved.consumption}</span>
        ) : previewConsumption ? (
          <span className="text-muted-foreground">~{previewConsumption}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <Button
          type="button"
          size="sm"
          variant={row.status === 'saved' ? 'outline' : 'default'}
          disabled={busy}
          onClick={save}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : row.status === 'saved' ? (
            'แก้ไข'
          ) : (
            <>
              <Save className="mr-1 h-3.5 w-3.5" />
              บันทึก
            </>
          )}
        </Button>
      </td>
    </tr>
  );
}

function ReadingRowMobile({
  companySlug,
  period,
  meter,
  unit,
  row,
  onPatch,
}: {
  companySlug: string;
  period: string;
  meter: GridMeter;
  unit: GridUnit;
  row: RowState;
  onPatch: (p: Partial<RowState>) => void;
}) {
  const { save, busy } = useRowSave(companySlug, period, meter.id, row, onPatch);
  const KindIcon = meter.kind === 'water' ? Droplet : Zap;
  const kindLabel = meter.kind === 'water' ? 'น้ำ' : 'ไฟ';
  const kindColor = meter.kind === 'water' ? 'text-sky-600' : 'text-amber-600';
  const previewConsumption = computeConsumptionPreview(row);

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="font-medium">{unit.unitNumber}</div>
          <div className={`flex items-center gap-1 text-xs ${kindColor}`}>
            <KindIcon className="h-3 w-3" />
            <span>
              {kindLabel} ({meter.unitOfMeasure})
            </span>
          </div>
        </div>
        <div className="text-right text-[11px] uppercase tracking-wide text-muted-foreground">
          ชั้น {unit.floor}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <p className="text-muted-foreground">ค่าก่อนหน้า</p>
          <p className="font-mono">{row.saved ? row.saved.valuePrevious : '—'}</p>
        </div>
        <div>
          <p className="text-muted-foreground">ใช้ไป</p>
          <p className="font-mono">
            {row.status === 'saved' && row.saved
              ? row.saved.consumption
              : previewConsumption
                ? `~${previewConsumption}`
                : '—'}
          </p>
        </div>
      </div>

      <div>
        <Label htmlFor={`mobile-${meter.id}`} className="text-xs">
          ค่าปัจจุบัน
        </Label>
        <div className="mt-1 flex gap-2">
          <Input
            id={`mobile-${meter.id}`}
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            placeholder="0.00"
            value={row.inputValue}
            disabled={busy}
            onChange={(e) =>
              onPatch({
                inputValue: e.target.value,
                status: row.status === 'saved' ? 'idle' : row.status,
              })
            }
            className="font-mono"
            aria-invalid={row.status === 'error' ? 'true' : undefined}
          />
          <Button
            type="button"
            size="sm"
            variant={row.status === 'saved' ? 'outline' : 'default'}
            disabled={busy}
            onClick={save}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : row.status === 'saved' ? (
              'แก้ไข'
            ) : (
              <Save className="h-4 w-4" />
            )}
          </Button>
        </div>
        {row.error ? <p className="mt-1 text-[11px] text-destructive">{row.error}</p> : null}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Best-effort client-side consumption preview using JS Number subtraction.
 * Fine for "did I type 1334 instead of 134?" sanity check — NOT used for
 * any persisted value (server uses Decimal math, single source of truth).
 *
 * Returns a 2-decimal string or `null` when either side isn't a valid number.
 */
function computeConsumptionPreview(row: RowState): string | null {
  if (!row.inputValue.trim()) return null;
  const current = Number(row.inputValue);
  if (Number.isNaN(current)) return null;
  const previous = row.saved ? Number(row.saved.valuePrevious) : 0;
  if (Number.isNaN(previous)) return null;
  const diff = current - previous;
  if (diff < 0) return null;
  return diff.toFixed(2);
}
