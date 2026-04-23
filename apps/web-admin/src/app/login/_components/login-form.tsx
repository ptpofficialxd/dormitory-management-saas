'use client';

import { loginAction } from '@/actions/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { type LoginAdminInput, loginAdminInputSchema } from '@dorm/shared/zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';

interface LoginFormProps {
  /** Pre-fill the slug field when ?slug=… is in the URL (set by middleware). */
  defaultCompanySlug?: string;
  /** Path to redirect to after login (sanitised by `loginAction`). */
  next?: string;
}

/**
 * Client-side login form.
 *
 * Pattern: react-hook-form + zodResolver does CLIENT-side validation +
 * inline error rendering, then submits the typed payload to a Server Action
 * (`loginAction`). The action re-validates with the same schema (defence in
 * depth — never trust the client parse), POSTs /auth/login, sets cookies,
 * and `redirect()`s. Only failures return — success throws NEXT_REDIRECT.
 *
 * `useTransition` keeps the UI responsive while the action is in-flight and
 * lets us show a loading state without a separate `isLoading` ref.
 */
export function LoginForm({ defaultCompanySlug = '', next }: LoginFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginAdminInput>({
    resolver: zodResolver(loginAdminInputSchema),
    defaultValues: {
      companySlug: defaultCompanySlug,
      email: '',
      password: '',
    },
    mode: 'onBlur',
  });

  const onSubmit = handleSubmit((values) => {
    setServerError(null);
    startTransition(async () => {
      const result = await loginAction(values, next);
      // Success path: `redirect()` threw on the server, so `result` here is
      // `undefined` (the function never returned). Only failure returns.
      if (result && !result.ok) {
        setServerError(result.message);
        return;
      }
      // Belt-and-braces: refresh router cache so subsequent navigations see
      // the new cookies. Usually unnecessary because redirect already
      // hard-navigates, but cheap and defensive.
      router.refresh();
    });
  });

  const busy = isPending || isSubmitting;

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="companySlug">รหัสหอพัก</Label>
        <Input
          id="companySlug"
          autoComplete="organization"
          placeholder="my-dorm"
          disabled={busy}
          aria-invalid={errors.companySlug ? 'true' : undefined}
          {...register('companySlug')}
        />
        {errors.companySlug ? (
          <p className="text-xs text-destructive">{errors.companySlug.message}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">อีเมล</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="owner@example.com"
          disabled={busy}
          aria-invalid={errors.email ? 'true' : undefined}
          {...register('email')}
        />
        {errors.email ? <p className="text-xs text-destructive">{errors.email.message}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">รหัสผ่าน</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          disabled={busy}
          aria-invalid={errors.password ? 'true' : undefined}
          {...register('password')}
        />
        {errors.password ? (
          <p className="text-xs text-destructive">{errors.password.message}</p>
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

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
      </Button>
    </form>
  );
}
