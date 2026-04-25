'use client';

import { createContractAction } from '@/actions/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { type CreateContractInput, createContractInputSchema } from '@/queries/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';

/**
 * Smaller picker shapes (server-side projected from the full wire schemas
 * before crossing the Server → Client Component boundary). Keeps the
 * payload lean + avoids serialising `Date` objects / leftover PII.
 */
export type PickerUnit = {
  id: string;
  propertyId: string;
  unitNumber: string;
  baseRent: string; // Decimal as string (ADR-0005)
};
export type PickerTenant = {
  id: string;
  displayName: string;
  /**
   * Best-effort hint that this tenant might already be on a contract.
   * Server-side we use `lineUserId != null` as the proxy — admin can still
   * select them (a tenant CAN have multiple sequential contracts on
   * different units). We just dim the option to nudge correct usage.
   */
  hasContract: boolean;
};
export type PickerProperty = { id: string; name: string };

/**
 * ContractForm — react-hook-form + zodResolver + Server Action.
 *
 * Mirrors PropertyForm / TenantForm pattern (Tasks #62, #79) plus:
 *   - Auto-fill rent + deposit from `unit.baseRent` when unit picked
 *     (admin can override before submit; the value is a snapshot at
 *     create time per ADR — `unit.baseRent` increases later don't
 *     reprice existing contracts)
 *   - Group unit picker by property name so the dropdown is scannable
 *
 * Date fields use HTML5 `<input type="date">` — yields `YYYY-MM-DD`
 * strings that match `isoDateSchema` directly (no Date round-trip).
 */
export function ContractForm({
  companySlug,
  units,
  tenants,
  properties,
}: {
  companySlug: string;
  units: PickerUnit[];
  tenants: PickerTenant[];
  properties: PickerProperty[];
}) {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  // Default startDate = today, in YYYY-MM-DD (Asia/Bangkok). HTML date input
  // doesn't timezone-shift the value, so we just hand it the local YYYY-MM-DD.
  const today = useMemo(() => {
    const tz = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return tz.format(new Date()); // en-CA always emits YYYY-MM-DD
  }, []);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CreateContractInput>({
    resolver: zodResolver(createContractInputSchema),
    defaultValues: {
      unitId: '',
      tenantId: '',
      startDate: today,
      endDate: undefined,
      rentAmount: '',
      depositAmount: '',
      notes: '',
    },
    mode: 'onBlur',
  });

  const watchedUnitId = watch('unitId');
  // Group units by property for the optgroup'd dropdown.
  const propertyName = useMemo(
    () => Object.fromEntries(properties.map((p) => [p.id, p.name])) as Record<string, string>,
    [properties],
  );
  const unitsByProperty = useMemo(() => {
    const map = new Map<string, PickerUnit[]>();
    for (const u of units) {
      const list = map.get(u.propertyId) ?? [];
      list.push(u);
      map.set(u.propertyId, list);
    }
    // Stable order: property name asc, then unit number asc.
    for (const list of map.values()) {
      list.sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, 'th'));
    }
    return [...map.entries()].sort(([a], [b]) =>
      (propertyName[a] ?? '').localeCompare(propertyName[b] ?? '', 'th'),
    );
  }, [units, propertyName]);

  const onUnitChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const unitId = e.target.value;
    setValue('unitId', unitId, { shouldValidate: true });
    // Auto-fill rent + deposit from baseRent. Admin can override afterwards;
    // we only fill if the field is currently blank to avoid clobbering an
    // explicit number.
    const picked = units.find((u) => u.id === unitId);
    if (picked) {
      setValue('rentAmount', picked.baseRent, { shouldValidate: true });
      setValue('depositAmount', picked.baseRent, { shouldValidate: true });
    }
  };

  const onSubmit = handleSubmit((values) => {
    setServerError(null);
    startTransition(async () => {
      const trimmedNotes = values.notes?.trim();
      const payload: CreateContractInput = {
        unitId: values.unitId,
        tenantId: values.tenantId,
        startDate: values.startDate,
        ...(values.endDate ? { endDate: values.endDate } : {}),
        rentAmount: String(values.rentAmount).trim(),
        depositAmount: String(values.depositAmount).trim(),
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      };
      const result = await createContractAction(companySlug, payload);
      if (result && !result.ok) {
        setServerError(result.message);
      }
    });
  });

  const busy = isPending || isSubmitting;

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {/* Unit picker (grouped by property) */}
      <div className="space-y-2">
        <Label htmlFor="unitId">ห้อง</Label>
        <select
          id="unitId"
          disabled={busy}
          aria-invalid={errors.unitId ? 'true' : undefined}
          {...register('unitId')}
          onChange={onUnitChange}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">— เลือกห้อง —</option>
          {unitsByProperty.map(([propertyId, list]) => (
            <optgroup key={propertyId} label={propertyName[propertyId] ?? 'ไม่ระบุอาคาร'}>
              {list.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.unitNumber} (฿{Number(u.baseRent).toLocaleString('th-TH')}/เดือน)
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {errors.unitId ? <p className="text-xs text-destructive">{errors.unitId.message}</p> : null}
      </div>

      {/* Tenant picker */}
      <div className="space-y-2">
        <Label htmlFor="tenantId">ผู้เช่า</Label>
        <select
          id="tenantId"
          disabled={busy}
          aria-invalid={errors.tenantId ? 'true' : undefined}
          {...register('tenantId')}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">— เลือกผู้เช่า —</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.displayName}
              {t.hasContract ? ' (อาจมีสัญญาอยู่แล้ว)' : ''}
            </option>
          ))}
        </select>
        {errors.tenantId ? (
          <p className="text-xs text-destructive">{errors.tenantId.message}</p>
        ) : null}
      </div>

      {/* Date pair */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="startDate">วันเริ่มสัญญา</Label>
          <Input
            id="startDate"
            type="date"
            disabled={busy}
            aria-invalid={errors.startDate ? 'true' : undefined}
            {...register('startDate')}
          />
          {errors.startDate ? (
            <p className="text-xs text-destructive">{errors.startDate.message}</p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="endDate">วันสิ้นสุด (ถ้ามี)</Label>
          <Input
            id="endDate"
            type="date"
            disabled={busy}
            aria-invalid={errors.endDate ? 'true' : undefined}
            {...register('endDate')}
          />
          <p className="text-xs text-muted-foreground">ปล่อยว่าง = สัญญาเดือน-ต่อ-เดือน (ไม่กำหนดสิ้นสุด)</p>
          {errors.endDate ? (
            <p className="text-xs text-destructive">{errors.endDate.message}</p>
          ) : null}
        </div>
      </div>

      {/* Money pair */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="rentAmount">ค่าเช่า/เดือน (บาท)</Label>
          <Input
            id="rentAmount"
            type="text"
            inputMode="decimal"
            placeholder="5500.00"
            disabled={busy}
            aria-invalid={errors.rentAmount ? 'true' : undefined}
            {...register('rentAmount')}
          />
          <p className="text-xs text-muted-foreground">
            {watchedUnitId ? 'เริ่มต้นจาก baseRent ของห้อง — แก้ได้' : 'เลือกห้องก่อนจะ auto-fill'}
          </p>
          {errors.rentAmount ? (
            <p className="text-xs text-destructive">{errors.rentAmount.message}</p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="depositAmount">เงินประกัน (บาท)</Label>
          <Input
            id="depositAmount"
            type="text"
            inputMode="decimal"
            placeholder="5500.00"
            disabled={busy}
            aria-invalid={errors.depositAmount ? 'true' : undefined}
            {...register('depositAmount')}
          />
          <p className="text-xs text-muted-foreground">มัดจำ คืนตอนย้ายออกถ้าไม่มีค่าเสียหาย</p>
          {errors.depositAmount ? (
            <p className="text-xs text-destructive">{errors.depositAmount.message}</p>
          ) : null}
        </div>
      </div>

      {/* Notes */}
      <div className="space-y-2">
        <Label htmlFor="notes">บันทึกเพิ่มเติม (ถ้ามี)</Label>
        <textarea
          id="notes"
          rows={3}
          disabled={busy}
          aria-invalid={errors.notes ? 'true' : undefined}
          {...register('notes')}
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="เช่น สัญญารายไตรมาส / มีเฟอร์นิเจอร์เพิ่ม / ฯลฯ"
        />
        {errors.notes ? <p className="text-xs text-destructive">{errors.notes.message}</p> : null}
      </div>

      {serverError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive"
        >
          {serverError}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={busy}>
          {busy ? 'กำลังบันทึก…' : 'บันทึกเป็นร่าง'}
        </Button>
      </div>
    </form>
  );
}
