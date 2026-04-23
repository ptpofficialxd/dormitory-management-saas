'use client';

import { createPropertyAction } from '@/actions/properties';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { type CreatePropertyInput, createPropertyInputSchema } from '@/queries/properties';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';

/**
 * PropertyForm — react-hook-form + zodResolver + Server Action.
 *
 * Same pattern as the LoginForm (Task #58):
 *   - Client validation via zodResolver gives instant inline errors,
 *   - Server Action re-validates with the SAME schema (defence in depth),
 *   - On success the action `revalidatePath()` + `redirect()`s back to the
 *     list page; on failure it returns a discriminated `{ ok: false, code,
 *     message }` we surface inline.
 *
 * `useTransition` keeps the form interactive during the action call without
 * blocking React's commit queue.
 */
export function PropertyForm({ companySlug }: { companySlug: string }) {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreatePropertyInput>({
    resolver: zodResolver(createPropertyInputSchema),
    defaultValues: { slug: '', name: '', address: '' },
    mode: 'onBlur',
  });

  const onSubmit = handleSubmit((values) => {
    setServerError(null);
    startTransition(async () => {
      // Empty string → undefined so the optional schema field stays optional
      // (sending `address: ''` would fail the max(512) check on a typed
      // empty string; cleaner to drop the key entirely).
      const trimmedAddress = values.address?.trim();
      const payload: CreatePropertyInput = {
        slug: values.slug.trim(),
        name: values.name.trim(),
        ...(trimmedAddress ? { address: trimmedAddress } : {}),
      };
      const result = await createPropertyAction(companySlug, payload);
      if (result && !result.ok) {
        setServerError(result.message);
      }
      // Success: redirect happened server-side; nothing to do here.
    });
  });

  const busy = isPending || isSubmitting;

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="slug">รหัสอาคาร (slug)</Label>
        <Input
          id="slug"
          autoComplete="off"
          placeholder="main-building"
          disabled={busy}
          aria-invalid={errors.slug ? 'true' : undefined}
          {...register('slug')}
        />
        <p className="text-xs text-muted-foreground">
          ใช้ตัวอักษรพิมพ์เล็ก ตัวเลข และเครื่องหมาย "-" เท่านั้น (เช่น <code>tower-a</code>)
        </p>
        {errors.slug ? <p className="text-xs text-destructive">{errors.slug.message}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="name">ชื่ออาคาร</Label>
        <Input
          id="name"
          autoComplete="off"
          placeholder="เช่น ตึก A, อาคารหลัก, EasySlip Main Building"
          disabled={busy}
          aria-invalid={errors.name ? 'true' : undefined}
          {...register('name')}
        />
        {errors.name ? <p className="text-xs text-destructive">{errors.name.message}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="address">ที่อยู่ (ถ้ามี)</Label>
        <Input
          id="address"
          autoComplete="off"
          placeholder="เช่น 99 ถนน... ตำบล... อำเภอ... จังหวัด..."
          disabled={busy}
          aria-invalid={errors.address ? 'true' : undefined}
          {...register('address')}
        />
        {errors.address ? (
          <p className="text-xs text-destructive">{errors.address.message}</p>
        ) : null}
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
