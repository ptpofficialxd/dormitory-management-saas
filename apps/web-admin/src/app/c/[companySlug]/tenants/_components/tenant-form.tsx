'use client';

import { createTenantAction } from '@/actions/tenants';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { type CreateTenantInput, createTenantInputSchema } from '@/queries/tenants';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';

/**
 * TenantForm — react-hook-form + zodResolver + Server Action.
 *
 * Same pattern as PropertyForm (Task #62):
 *   - Client validation via zodResolver gives instant inline errors,
 *   - Server Action re-validates with the SAME canonical shared schema
 *     (defence in depth — never trust the client parse),
 *   - On success the action `revalidatePath()` + `redirect()`s back to
 *     the list page; on failure it returns a discriminated `{ ok: false,
 *     code, message }` we surface inline.
 *
 * `useTransition` keeps the form interactive during the action call
 * without blocking React's commit queue.
 *
 * Field notes:
 *   - displayName: required, max 128 chars
 *   - phone: optional 10-digit Thai mobile (validated by shared schema)
 *   - nationalId: optional 13-digit Thai national ID (PII — kept off the
 *     create form unless admin explicitly types it; encrypted at-rest
 *     before insert)
 *   - lineUserId / pictureUrl: omitted from this form — those land via
 *     the LIFF bind flow, not the admin-side onboarding.
 */
export function TenantForm({ companySlug }: { companySlug: string }) {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateTenantInput>({
    resolver: zodResolver(createTenantInputSchema),
    defaultValues: { displayName: '', phone: '', nationalId: '' },
    mode: 'onBlur',
  });

  const onSubmit = handleSubmit((values) => {
    setServerError(null);
    startTransition(async () => {
      // Trim + drop empty optional fields so the canonical schema parse
      // doesn't reject `''` on `thaiMobileSchema.optional()` (an empty
      // string is NOT undefined — the schema would still try to validate
      // shape and fail). Mirrors PropertyForm's normalisation.
      const trimmedPhone = values.phone?.trim();
      const trimmedNationalId = values.nationalId?.trim();
      const payload: CreateTenantInput = {
        displayName: values.displayName.trim(),
        ...(trimmedPhone ? { phone: trimmedPhone } : {}),
        ...(trimmedNationalId ? { nationalId: trimmedNationalId } : {}),
      };
      const result = await createTenantAction(companySlug, payload);
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
        <Label htmlFor="displayName">ชื่อแสดง</Label>
        <Input
          id="displayName"
          autoComplete="off"
          placeholder="เช่น คุณสมชาย, นางสาวพิม"
          disabled={busy}
          aria-invalid={errors.displayName ? 'true' : undefined}
          {...register('displayName')}
        />
        <p className="text-xs text-muted-foreground">
          ใช้แสดงในระบบ + แสดงใน LINE — ใส่ชื่อเล่นหรือชื่อจริงก็ได้
        </p>
        {errors.displayName ? (
          <p className="text-xs text-destructive">{errors.displayName.message}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="phone">เบอร์โทรศัพท์ (ถ้ามี)</Label>
        <Input
          id="phone"
          type="tel"
          autoComplete="tel"
          inputMode="numeric"
          placeholder="0812345678"
          maxLength={10}
          disabled={busy}
          aria-invalid={errors.phone ? 'true' : undefined}
          {...register('phone')}
        />
        <p className="text-xs text-muted-foreground">
          10 หลัก เริ่ม 0 เท่านั้น — ใช้ติดต่อยามฉุกเฉิน, encrypt at-rest
        </p>
        {errors.phone ? <p className="text-xs text-destructive">{errors.phone.message}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="nationalId">เลขบัตรประชาชน (ถ้ามี)</Label>
        <Input
          id="nationalId"
          autoComplete="off"
          inputMode="numeric"
          placeholder="1234567890123"
          maxLength={13}
          disabled={busy}
          aria-invalid={errors.nationalId ? 'true' : undefined}
          {...register('nationalId')}
        />
        <p className="text-xs text-muted-foreground">
          13 หลัก, ไม่ต้องใส่ขีด — encrypt at-rest, แสดงเป็น "X-XXXX-XXXXX-12-3" ในรายการ
        </p>
        {errors.nationalId ? (
          <p className="text-xs text-destructive">{errors.nationalId.message}</p>
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
