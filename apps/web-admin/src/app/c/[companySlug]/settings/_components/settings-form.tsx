'use client';

import { setPromptPayAction } from '@/actions/company';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Can } from '@/lib/rbac';
import {
  type UpdatePromptPaySettingsInput,
  updatePromptPaySettingsInputSchema,
} from '@/queries/company';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';

/**
 * SettingsForm — PromptPay payee config (Phase 1.3).
 *
 * Mirrors PropertyForm / TenantForm / ContractForm pattern:
 *   - rhf + zodResolver for inline validation
 *   - Server Action re-validates with the SAME canonical schema
 *   - useTransition keeps the form interactive during the round-trip
 *
 * RBAC: form rendered only when caller has `update:company` (owner-only
 * per the matrix). Property managers see a read-only state instead so
 * they know the value but can't change it.
 *
 * `mode: 'onChange'` here (not 'onBlur' like other forms) because the
 * PromptPay regex is the user's main feedback loop — typing 13 vs 10
 * digits matters and we want the inline error to land before they
 * tab away.
 */
export function SettingsForm({
  companySlug,
  initialPromptPayId,
  initialPromptPayName,
}: {
  companySlug: string;
  initialPromptPayId: string;
  initialPromptPayName: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<UpdatePromptPaySettingsInput>({
    resolver: zodResolver(updatePromptPaySettingsInputSchema),
    defaultValues: {
      promptPayId: initialPromptPayId,
      promptPayName: initialPromptPayName,
    },
    mode: 'onChange',
  });

  const onSubmit = handleSubmit((values) => {
    setServerError(null);
    setSavedAt(null);
    startTransition(async () => {
      const payload: UpdatePromptPaySettingsInput = {
        promptPayId: values.promptPayId.replace(/\D/g, ''), // strip dashes/spaces
        promptPayName: values.promptPayName.trim(),
      };
      const result = await setPromptPayAction(companySlug, payload);
      if (result && !result.ok) {
        setServerError(result.message);
        return;
      }
      setSavedAt(new Date());
    });
  });

  const busy = isPending || isSubmitting;

  return (
    <Can
      action="update"
      resource="company"
      fallback={
        <ReadOnlyView promptPayId={initialPromptPayId} promptPayName={initialPromptPayName} />
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="promptPayId">PromptPay ID</Label>
          <Input
            id="promptPayId"
            inputMode="numeric"
            placeholder="0812345678 (เบอร์มือถือ) หรือ 1234567890123 (เลขบัตร)"
            disabled={busy}
            aria-invalid={errors.promptPayId ? 'true' : undefined}
            {...register('promptPayId')}
          />
          <p className="text-xs text-muted-foreground">
            รับ 3 รูปแบบ — เบอร์มือถือ (10 หลัก, ขึ้นต้น 0), เลขบัตรประชาชน (13 หลัก), หรือ e-Wallet ID (15 หลัก)
            — ไม่ต้องใส่ขีด
          </p>
          {errors.promptPayId ? (
            <p className="text-xs text-destructive">{errors.promptPayId.message}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="promptPayName">ชื่อผู้รับโอน</Label>
          <Input
            id="promptPayName"
            placeholder="เช่น EasySlip Dorm"
            maxLength={25}
            disabled={busy}
            aria-invalid={errors.promptPayName ? 'true' : undefined}
            {...register('promptPayName')}
          />
          <p className="text-xs text-muted-foreground">
            แสดงในแอพธนาคารผู้เช่าตอนสแกน QR — สูงสุด 25 ตัวอักษร (ASCII เท่านั้น, อักษรไทยจะแสดงเป็นกล่อง)
          </p>
          {errors.promptPayName ? (
            <p className="text-xs text-destructive">{errors.promptPayName.message}</p>
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

        {savedAt ? (
          // <output> has implicit role="status" + aria-live="polite", so it
          // announces the save result to screen readers without us managing
          // the ARIA attributes manually (Biome's useSemanticElements rule).
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

        <div className="flex justify-end gap-2 pt-2">
          <Button type="submit" disabled={busy || !isDirty}>
            {busy ? 'กำลังบันทึก…' : 'บันทึก'}
          </Button>
        </div>
      </form>
    </Can>
  );
}

/**
 * Read-only view shown to non-owner roles (e.g. property_manager).
 * Same layout as the form, but no inputs — just the current values.
 */
function ReadOnlyView({
  promptPayId,
  promptPayName,
}: {
  promptPayId: string;
  promptPayName: string;
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">PromptPay ID</p>
        <p className="font-mono text-sm">{promptPayId || '— ยังไม่ได้ตั้ง —'}</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">ชื่อผู้รับโอน</p>
        <p className="text-sm">{promptPayName || '— ยังไม่ได้ตั้ง —'}</p>
      </div>
      <p className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
        เฉพาะเจ้าของหอเท่านั้นที่แก้ไขได้ — ติดต่อเจ้าของถ้าต้องการเปลี่ยนบัญชีรับโอน
      </p>
    </div>
  );
}
