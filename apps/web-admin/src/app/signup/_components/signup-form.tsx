'use client';

import { checkSlugAction, signupAction } from '@/actions/signup';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { normalizeSlug } from '@dorm/shared/slug';
import { type SignupInput, type SlugUnavailableReason, signupInputSchema } from '@dorm/shared/zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';

/**
 * AUTH-004 (Task #114) — single-step self-signup wizard.
 *
 * UX details:
 *   - companyName auto-suggests a slug via `normalizeSlug` until the user
 *     manually edits the slug field. We track "user touched slug" with a
 *     ref so re-typing the company name doesn't clobber a hand-picked slug.
 *   - Slug availability is probed via `checkSlugAction` with a 500ms debounce
 *     (no shared `useDebounce` hook in this codebase yet; we inline a tiny
 *     timer + AbortController-style cancellation via a stale-token guard).
 *   - On submit, server action sets cookies + `redirect()`s to /signup/welcome.
 */

type SlugStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available' }
  | { kind: 'unavailable'; reason: SlugUnavailableReason };

const SLUG_STATUS_DEBOUNCE_MS = 500;

const REASON_MESSAGES: Record<string, string> = {
  too_short: 'รหัสหอพักต้องยาวอย่างน้อย 2 ตัวอักษร',
  too_long: 'รหัสหอพักยาวเกิน 64 ตัวอักษร',
  invalid_chars: 'ใช้ได้เฉพาะตัวพิมพ์เล็ก / ตัวเลข / ขีดกลาง — ห้ามขึ้นต้นหรือลงท้ายด้วยขีดกลาง',
  reserved: 'รหัสนี้สงวนไว้สำหรับระบบ — กรุณาเลือกชื่ออื่น',
  taken: 'รหัสนี้ถูกใช้แล้ว — กรุณาเลือกชื่ออื่น',
};

export function SignupForm() {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [slugStatus, setSlugStatus] = useState<SlugStatus>({ kind: 'idle' });

  // Tracks whether the user has manually edited the slug field. Until then,
  // typing into companyName auto-fills slug from a normalized version.
  const slugTouched = useRef(false);
  // Stale-probe guard: every probe gets a token; only the most recent one is
  // allowed to update state when it returns. Avoids flicker when the user is
  // still typing.
  const probeToken = useRef(0);

  const form = useForm<SignupInput>({
    resolver: zodResolver(signupInputSchema),
    defaultValues: {
      companyName: '',
      slug: '',
      ownerEmail: '',
      ownerPassword: '',
      ownerDisplayName: '',
      acceptTerms: true as const, // intentionally pre-ticked; user can untick
    },
    mode: 'onBlur',
  });
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = form;

  const companyName = watch('companyName');
  const slug = watch('slug');

  // Auto-suggest slug from companyName until the user touches the slug field.
  useEffect(() => {
    if (slugTouched.current) return;
    const suggested = normalizeSlug(companyName);
    if (suggested && suggested !== slug) {
      setValue('slug', suggested, { shouldValidate: false, shouldDirty: false });
    }
  }, [companyName, slug, setValue]);

  // Debounced availability probe. Skip if slug is empty (idle state).
  useEffect(() => {
    if (!slug) {
      setSlugStatus({ kind: 'idle' });
      return;
    }
    setSlugStatus({ kind: 'checking' });
    const myToken = ++probeToken.current;
    const timer = setTimeout(async () => {
      const result = await checkSlugAction(slug);
      if (probeToken.current !== myToken) return; // a newer probe started
      if (result.available) {
        setSlugStatus({ kind: 'available' });
      } else {
        setSlugStatus({ kind: 'unavailable', reason: result.reason });
      }
    }, SLUG_STATUS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [slug]);

  const onSubmit = handleSubmit((values) => {
    setServerError(null);
    startTransition(async () => {
      const result = await signupAction(values);
      // Success path throws redirect — only failures return.
      if (result && !result.ok) {
        setServerError(result.message);
      }
    });
  });

  const busy = isPending || isSubmitting;

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="su-companyName">ชื่อหอพัก</Label>
        <Input
          id="su-companyName"
          autoComplete="organization"
          placeholder="เช่น Easyslip Dorm"
          disabled={busy}
          aria-invalid={errors.companyName ? 'true' : undefined}
          {...register('companyName')}
        />
        {errors.companyName ? (
          <p className="text-xs text-destructive">{errors.companyName.message}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="su-slug">รหัสหอพัก (ใช้ในลิงก์)</Label>
          <SlugStatusBadge status={slugStatus} />
        </div>
        <div className="flex items-center gap-1 rounded-md border bg-background px-2 focus-within:border-primary">
          <span className="select-none text-xs text-muted-foreground">/c/</span>
          <Input
            id="su-slug"
            autoComplete="off"
            placeholder="my-dorm"
            disabled={busy}
            aria-invalid={errors.slug ? 'true' : undefined}
            className="border-0 px-1 focus-visible:ring-0"
            {...register('slug', {
              onChange: () => {
                slugTouched.current = true;
              },
            })}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          ใช้ตัวพิมพ์เล็ก / ตัวเลข / ขีดกลาง 2–64 ตัว — ตั้งครั้งเดียว เปลี่ยนได้ในภายหลังโดยติดต่อทีม
        </p>
        {errors.slug ? <p className="text-xs text-destructive">{errors.slug.message}</p> : null}
        {slugStatus.kind === 'unavailable' ? (
          <p className="text-xs text-destructive">
            {REASON_MESSAGES[slugStatus.reason] ?? 'ไม่สามารถใช้รหัสนี้'}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="su-ownerEmail">อีเมลเจ้าของหอ</Label>
        <Input
          id="su-ownerEmail"
          type="email"
          autoComplete="email"
          placeholder="owner@example.com"
          disabled={busy}
          aria-invalid={errors.ownerEmail ? 'true' : undefined}
          {...register('ownerEmail')}
        />
        {errors.ownerEmail ? (
          <p className="text-xs text-destructive">{errors.ownerEmail.message}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="su-ownerPassword">รหัสผ่าน</Label>
        <Input
          id="su-ownerPassword"
          type="password"
          autoComplete="new-password"
          placeholder="อย่างน้อย 8 ตัวอักษร"
          disabled={busy}
          aria-invalid={errors.ownerPassword ? 'true' : undefined}
          {...register('ownerPassword')}
        />
        {errors.ownerPassword ? (
          <p className="text-xs text-destructive">{errors.ownerPassword.message}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="su-ownerDisplayName">ชื่อที่แสดงในระบบ</Label>
        <Input
          id="su-ownerDisplayName"
          autoComplete="name"
          placeholder="เช่น คุณวรชัย"
          disabled={busy}
          aria-invalid={errors.ownerDisplayName ? 'true' : undefined}
          {...register('ownerDisplayName')}
        />
        {errors.ownerDisplayName ? (
          <p className="text-xs text-destructive">{errors.ownerDisplayName.message}</p>
        ) : null}
      </div>

      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input type="checkbox" className="mt-0.5" disabled={busy} {...register('acceptTerms')} />
        <span>
          ฉันยอมรับ{' '}
          <a className="text-primary underline" href="/terms" target="_blank" rel="noreferrer">
            ข้อกำหนดการใช้งาน
          </a>{' '}
          และ{' '}
          <a className="text-primary underline" href="/privacy" target="_blank" rel="noreferrer">
            นโยบายความเป็นส่วนตัว (PDPA)
          </a>
        </span>
      </label>
      {errors.acceptTerms ? (
        <p className="text-xs text-destructive">กรุณายอมรับข้อกำหนดก่อนสมัคร</p>
      ) : null}

      {serverError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive"
        >
          {serverError}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={busy || slugStatus.kind === 'unavailable'}>
        {busy ? 'กำลังสมัคร…' : 'สมัครและเริ่มใช้ฟรี 14 วัน'}
      </Button>
    </form>
  );
}

function SlugStatusBadge({ status }: { status: SlugStatus }) {
  if (status.kind === 'idle') return null;
  if (status.kind === 'checking') {
    return <span className="text-xs text-muted-foreground">กำลังตรวจ…</span>;
  }
  if (status.kind === 'available') {
    return <span className="text-xs text-emerald-700 dark:text-emerald-400">✓ ใช้รหัสนี้ได้</span>;
  }
  return <span className="text-xs text-destructive">✗ ใช้ไม่ได้</span>;
}
