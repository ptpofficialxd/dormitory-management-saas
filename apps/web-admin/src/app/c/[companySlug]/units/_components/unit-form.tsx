'use client';

import { createUnitAction } from '@/actions/units';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { CreateUnitInput } from '@/queries/units';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

interface PropertyOption {
  id: string;
  name: string;
}

interface UnitFormProps {
  companySlug: string;
  properties: readonly PropertyOption[];
}

/**
 * Form-side schema (relaxed vs. the server's `createUnitInputSchema`).
 *
 * Why not reuse the shared schema directly?
 * - `moneySchema` rejects empty string (`""`), but native `<input>` with no
 *   typed value gives RHF an empty string, not `undefined`. With the strict
 *   schema as resolver, the user would get an "invalid format" error on
 *   sizeSqm before even touching it.
 * - We accept loose strings here, then normalise + drop empties in the
 *   submit handler. The Server Action re-validates with the canonical
 *   schema (defence in depth), so the strict rules still apply on the wire.
 */
const formSchema = z.object({
  propertyId: z.string().uuid('กรุณาเลือกอาคาร'),
  unitNumber: z.string().min(1, 'กรุณากรอกหมายเลขห้อง').max(32),
  floor: z.coerce.number().int('ชั้นต้องเป็นจำนวนเต็ม').min(0).max(200),
  baseRent: z.string().regex(/^\d{1,8}(?:\.\d{1,2})?$/, 'กรุณากรอกค่าเช่า เช่น 5500.00'),
  sizeSqm: z.string().optional(),
  notes: z.string().max(512).optional(),
});
type UnitFormValues = z.infer<typeof formSchema>;

const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

export function UnitForm({ companySlug, properties }: UnitFormProps) {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<UnitFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      propertyId: properties[0]?.id ?? '',
      unitNumber: '',
      floor: 1,
      baseRent: '',
      sizeSqm: '',
      notes: '',
    },
    mode: 'onBlur',
  });

  const onSubmit = handleSubmit((values) => {
    setServerError(null);
    startTransition(async () => {
      const trimmedSize = values.sizeSqm?.trim();
      const trimmedNotes = values.notes?.trim();
      const payload: CreateUnitInput = {
        propertyId: values.propertyId,
        unitNumber: values.unitNumber.trim(),
        floor: values.floor,
        baseRent: values.baseRent.trim(),
        ...(trimmedSize ? { sizeSqm: trimmedSize } : {}),
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      };
      const result = await createUnitAction(companySlug, payload);
      if (result && !result.ok) {
        setServerError(result.message);
      }
      // Success: redirect happened server-side; nothing to do.
    });
  });

  const busy = isPending || isSubmitting;

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="propertyId">อาคาร</Label>
        <select
          id="propertyId"
          className={cn(SELECT_CLASS)}
          disabled={busy}
          aria-invalid={errors.propertyId ? 'true' : undefined}
          {...register('propertyId')}
        >
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {errors.propertyId ? (
          <p className="text-xs text-destructive">{errors.propertyId.message}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="unitNumber">หมายเลขห้อง</Label>
          <Input
            id="unitNumber"
            placeholder="เช่น 101, A-205"
            disabled={busy}
            aria-invalid={errors.unitNumber ? 'true' : undefined}
            {...register('unitNumber')}
          />
          {errors.unitNumber ? (
            <p className="text-xs text-destructive">{errors.unitNumber.message}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="floor">ชั้น</Label>
          <Input
            id="floor"
            type="number"
            min={0}
            max={200}
            placeholder="1"
            disabled={busy}
            aria-invalid={errors.floor ? 'true' : undefined}
            {...register('floor')}
          />
          {errors.floor ? <p className="text-xs text-destructive">{errors.floor.message}</p> : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="baseRent">ค่าเช่า / เดือน (บาท)</Label>
          <Input
            id="baseRent"
            type="text"
            inputMode="decimal"
            placeholder="5500.00"
            disabled={busy}
            aria-invalid={errors.baseRent ? 'true' : undefined}
            {...register('baseRent')}
          />
          {errors.baseRent ? (
            <p className="text-xs text-destructive">{errors.baseRent.message}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="sizeSqm">ขนาด (m²) — ถ้ามี</Label>
          <Input
            id="sizeSqm"
            type="text"
            inputMode="decimal"
            placeholder="24.00"
            disabled={busy}
            aria-invalid={errors.sizeSqm ? 'true' : undefined}
            {...register('sizeSqm')}
          />
          {errors.sizeSqm ? (
            <p className="text-xs text-destructive">{errors.sizeSqm.message}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="notes">หมายเหตุ (ถ้ามี)</Label>
        <Input
          id="notes"
          placeholder="เช่น มีระเบียง / วิวสระน้ำ"
          disabled={busy}
          aria-invalid={errors.notes ? 'true' : undefined}
          {...register('notes')}
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
          {busy ? 'กำลังบันทึก…' : 'บันทึก'}
        </Button>
      </div>
    </form>
  );
}
