'use client';

import { upsertLineChannelAction } from '@/actions/line-channel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Can } from '@/lib/rbac';
import {
  type UpsertCompanyLineChannelInput,
  upsertCompanyLineChannelInputSchema,
} from '@/queries/line-channel';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';

interface LineChannelFormProps {
  companySlug: string;
  /** Current saved channel ID (empty string if not configured yet). */
  initialChannelId: string;
  /** Current saved basic ID (empty if not set). */
  initialBasicId: string;
  /** Current saved display name (empty if not set). */
  initialDisplayName: string;
  /** Whether secret is already saved server-side (UI badge only). */
  hasChannelSecret: boolean;
  /** Whether access token is already saved server-side. */
  hasChannelAccessToken: boolean;
}

/**
 * LINE OA channel settings form (Task #109).
 *
 * Pattern matches SettingsForm (PromptPay) — rhf + zodResolver + Server
 * Action + useTransition. RBAC: requires `update:company` (owner +
 * property_manager per matrix). Staff sees a read-only summary instead.
 *
 * Secrets handling:
 *   - GET endpoint NEVER returns the plaintext secret/access token. We
 *     only know whether they're set via the `hasChannelSecret` /
 *     `hasChannelAccessToken` booleans from CompanyLineChannelPublic.
 *   - Form leaves the two secret inputs EMPTY. To rotate or first-set,
 *     admin must paste the values fresh — we never round-trip them.
 *   - Bookkeeping: save = "rotate everything" semantically. There's no
 *     partial-save in v1; basicId / displayName get saved together with
 *     the secrets. Phase 1 wishlist: separate "rotate token" button
 *     that doesn't require re-entering basicId.
 */
export function LineChannelForm({
  companySlug,
  initialChannelId,
  initialBasicId,
  initialDisplayName,
  hasChannelSecret,
  hasChannelAccessToken,
}: LineChannelFormProps) {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<UpsertCompanyLineChannelInput>({
    resolver: zodResolver(upsertCompanyLineChannelInputSchema),
    defaultValues: {
      channelId: initialChannelId,
      channelSecret: '',
      channelAccessToken: '',
      basicId: initialBasicId || undefined,
      displayName: initialDisplayName || undefined,
    },
    mode: 'onBlur',
  });

  const onSubmit = handleSubmit((values) => {
    setServerError(null);
    setSavedAt(null);
    startTransition(async () => {
      const payload: UpsertCompanyLineChannelInput = {
        channelId: values.channelId.trim(),
        channelSecret: values.channelSecret.trim(),
        channelAccessToken: values.channelAccessToken.trim(),
        basicId: values.basicId?.trim() || undefined,
        displayName: values.displayName?.trim() || undefined,
      };
      const result = await upsertLineChannelAction(companySlug, payload);
      if (!result.ok) {
        setServerError(result.message);
        return;
      }
      setSavedAt(new Date());
    });
  });

  const busy = isPending || isSubmitting;
  const isFirstSetup = !hasChannelSecret && !hasChannelAccessToken && !initialChannelId;

  return (
    <Can
      action="update"
      resource="company"
      fallback={
        <ReadOnlyView
          channelId={initialChannelId}
          basicId={initialBasicId}
          displayName={initialDisplayName}
          hasChannelSecret={hasChannelSecret}
          hasChannelAccessToken={hasChannelAccessToken}
        />
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {isFirstSetup ? (
          <p
            role="alert"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400"
          >
            ⚠️ ยังไม่ได้เชื่อม LINE OA — ผู้เช่าจะไม่ได้รับ push notification (บิลใหม่, ประกาศ, ผลตรวจสลิป)
            จนกว่าจะตั้งค่าครบ
          </p>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="lc-channelId">Channel ID</Label>
          <Input
            id="lc-channelId"
            inputMode="numeric"
            placeholder="เช่น 1234567890"
            disabled={busy}
            aria-invalid={errors.channelId ? 'true' : undefined}
            {...register('channelId')}
          />
          <p className="text-xs text-muted-foreground">
            เลข 9–10 หลักจาก LINE Developers Console → Messaging API → Channel ID
          </p>
          {errors.channelId ? (
            <p className="text-xs text-destructive">{errors.channelId.message}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="lc-channelSecret">Channel Secret</Label>
            {hasChannelSecret ? (
              <span className="text-xs text-emerald-700 dark:text-emerald-400">
                ✓ ตั้งไว้แล้ว — กรอกใหม่เพื่อ rotate
              </span>
            ) : null}
          </div>
          <Input
            id="lc-channelSecret"
            type="password"
            autoComplete="off"
            placeholder="hex 32 ตัวอักษร"
            disabled={busy}
            aria-invalid={errors.channelSecret ? 'true' : undefined}
            {...register('channelSecret')}
          />
          <p className="text-xs text-muted-foreground">
            จาก LINE Developers Console → Basic settings → Channel secret
          </p>
          {errors.channelSecret ? (
            <p className="text-xs text-destructive">{errors.channelSecret.message}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="lc-channelAccessToken">Channel Access Token</Label>
            {hasChannelAccessToken ? (
              <span className="text-xs text-emerald-700 dark:text-emerald-400">
                ✓ ตั้งไว้แล้ว — กรอกใหม่เพื่อ rotate
              </span>
            ) : null}
          </div>
          <Input
            id="lc-channelAccessToken"
            type="password"
            autoComplete="off"
            placeholder="long-lived token จาก Messaging API tab"
            disabled={busy}
            aria-invalid={errors.channelAccessToken ? 'true' : undefined}
            {...register('channelAccessToken')}
          />
          <p className="text-xs text-muted-foreground">
            จาก LINE Developers Console → Messaging API → Channel access token (long-lived) →
            "Issue"
          </p>
          {errors.channelAccessToken ? (
            <p className="text-xs text-destructive">{errors.channelAccessToken.message}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="lc-basicId">
            LINE Basic ID <span className="text-muted-foreground">(ไม่บังคับ)</span>
          </Label>
          <Input
            id="lc-basicId"
            placeholder="@easyslip-dorm"
            disabled={busy}
            aria-invalid={errors.basicId ? 'true' : undefined}
            {...register('basicId')}
          />
          <p className="text-xs text-muted-foreground">
            ID สาธารณะของ OA ขึ้นต้นด้วย @ — ใช้ในลิงก์ "เพิ่มเพื่อน OA" ที่แชร์ให้ผู้เช่า
          </p>
          {errors.basicId ? (
            <p className="text-xs text-destructive">{errors.basicId.message}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="lc-displayName">
            ชื่อ OA ที่จำง่าย <span className="text-muted-foreground">(ไม่บังคับ)</span>
          </Label>
          <Input
            id="lc-displayName"
            placeholder="เช่น EasySlip Dorm"
            maxLength={128}
            disabled={busy}
            aria-invalid={errors.displayName ? 'true' : undefined}
            {...register('displayName')}
          />
          <p className="text-xs text-muted-foreground">
            ใช้แค่ภายใน admin (เช่น เวลามีหลาย OA) — ไม่กระทบสิ่งที่ผู้เช่าเห็น
          </p>
          {errors.displayName ? (
            <p className="text-xs text-destructive">{errors.displayName.message}</p>
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
          <output className="block rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-700 dark:text-emerald-400">
            ✓ บันทึก LINE OA แล้วเมื่อ{' '}
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
            {busy ? 'กำลังบันทึก…' : 'บันทึก LINE OA'}
          </Button>
        </div>
      </form>
    </Can>
  );
}

function ReadOnlyView({
  channelId,
  basicId,
  displayName,
  hasChannelSecret,
  hasChannelAccessToken,
}: {
  channelId: string;
  basicId: string;
  displayName: string;
  hasChannelSecret: boolean;
  hasChannelAccessToken: boolean;
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Channel ID</p>
        <p className="font-mono text-sm">{channelId || '— ยังไม่ได้ตั้ง —'}</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Channel Secret</p>
        <p className="text-sm">{hasChannelSecret ? '✓ ตั้งไว้แล้ว (ไม่แสดงค่า)' : '— ยังไม่ได้ตั้ง —'}</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Channel Access Token
        </p>
        <p className="text-sm">{hasChannelAccessToken ? '✓ ตั้งไว้แล้ว (ไม่แสดงค่า)' : '— ยังไม่ได้ตั้ง —'}</p>
      </div>
      {basicId ? (
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">LINE Basic ID</p>
          <p className="font-mono text-sm">{basicId}</p>
        </div>
      ) : null}
      {displayName ? (
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">ชื่อ OA</p>
          <p className="text-sm">{displayName}</p>
        </div>
      ) : null}
      <p className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
        เฉพาะเจ้าของหอ + ผู้จัดการเท่านั้นที่ตั้งค่า LINE OA ได้
      </p>
    </div>
  );
}
