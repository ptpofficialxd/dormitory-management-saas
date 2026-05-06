'use client';

import { createBroadcastAction } from '@/actions/announcements';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  type CreateAnnouncementInput,
  createAnnouncementInputSchema,
} from '@/queries/announcements';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { type SubmitHandler, useForm } from 'react-hook-form';

interface AnnouncementFormProps {
  companySlug: string;
}

/**
 * Compose form for COM-003 (Task #108) — react-hook-form + zod + Server Action.
 *
 * v1 hard-codes the Zod-validated input shape:
 *   - target: { audience: 'all' }   (controller-side guard rejects others)
 *   - sendNow: true                 (controller-side guard rejects scheduling)
 *
 * The form only collects title + body from the user; the constants above
 * are appended in `onSubmit`. Phase 1 will widen the form (audience
 * picker + scheduledAt) once the targeting + scheduling endpoints land.
 *
 * Submit feedback uses an inline `<p role="alert">` rather than a toast —
 * keeps the form a single Client boundary and avoids pulling in a toast
 * provider just for this surface. On success: navigate to the detail page
 * so the admin can watch delivery counters tick up.
 */
export function AnnouncementForm({ companySlug }: AnnouncementFormProps) {
  const router = useRouter();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    watch,
  } = useForm<{ title: string; body: string }>({
    // We refine the form's local schema down to just the user-controlled
    // fields. The full createAnnouncementInputSchema (with target +
    // sendNow) is enforced in the Server Action — this lighter schema is
    // for inline UX (per-field error messages) only.
    resolver: zodResolver(createAnnouncementInputSchema.pick({ title: true, body: true })),
    defaultValues: { title: '', body: '' },
  });

  const bodyLength = watch('body')?.length ?? 0;

  const onSubmit: SubmitHandler<{ title: string; body: string }> = async (values) => {
    setSubmitError(null);

    const fullInput: CreateAnnouncementInput = {
      title: values.title,
      body: values.body,
      target: { audience: 'all' },
      sendNow: true,
    };

    const result = await createBroadcastAction(companySlug, fullInput);
    if (!result.ok) {
      setSubmitError(result.message);
      return;
    }

    // Drill into detail so admin sees delivery progress (status flips
    // from sending → sent over the next few seconds as workers run).
    router.push(`/c/${companySlug}/announcements/${result.announcementId}`);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="title">หัวข้อ</Label>
        <Input
          id="title"
          {...register('title')}
          placeholder="เช่น น้ำประปาดับ 13:00–15:00 วันนี้"
          maxLength={128}
          aria-invalid={errors.title ? 'true' : 'false'}
        />
        {errors.title ? (
          <p className="text-xs text-red-600">{errors.title.message}</p>
        ) : (
          <p className="text-xs text-muted-foreground">ไม่เกิน 128 ตัวอักษร</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="body">เนื้อหา</Label>
        <textarea
          id="body"
          {...register('body')}
          rows={8}
          maxLength={4000}
          placeholder="พิมพ์ข้อความที่ต้องการให้ผู้เช่าทุกคนได้รับ"
          aria-invalid={errors.body ? 'true' : 'false'}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div className="flex justify-between gap-2 text-xs">
          {errors.body ? (
            <p className="text-red-600">{errors.body.message}</p>
          ) : (
            <p className="text-muted-foreground">ไม่เกิน 4,000 ตัวอักษร</p>
          )}
          <p className="tabular-nums text-muted-foreground">
            {bodyLength.toLocaleString()} / 4,000
          </p>
        </div>
      </div>

      {submitError ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {submitError}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" asChild>
          <a href={`/c/${companySlug}/announcements`}>ยกเลิก</a>
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'กำลังส่ง…' : 'ส่งประกาศ'}
        </Button>
      </div>
    </form>
  );
}
