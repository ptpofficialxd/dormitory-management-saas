'use server';

import { ApiError, api } from '@/lib/api';
import { setAuthCookies } from '@/lib/cookies';
import {
  type CheckSlugResponse,
  type SignupInput,
  type SignupResponse,
  checkSlugInputSchema,
  checkSlugResponseSchema,
  signupInputSchema,
  signupResponseSchema,
} from '@dorm/shared/zod';
import { redirect } from 'next/navigation';

/**
 * AUTH-004 (Task #114) — Server Actions for the self-signup wizard.
 *
 * Two actions live here:
 *   - `signupAction` — submits the form, sets auth cookies, redirects to
 *     `/signup/welcome` where the new owner can pick what to set up first.
 *   - `checkSlugAction` — used by the form to give live feedback while the
 *     admin types into the slug field.
 *
 * Mirrors `actions/auth.ts`'s shape: discriminated-union result, friendly Thai
 * error messages, no leakage of stack traces.
 */

export type SignupActionResult =
  | {
      ok: false;
      code: 'VALIDATION' | 'INVALID_SLUG' | 'SLUG_TAKEN' | 'NETWORK' | 'UNKNOWN';
      message: string;
    }
  | { ok: true };

export async function signupAction(input: SignupInput): Promise<SignupActionResult> {
  // Defence-in-depth: re-validate server-side. Client also validates via
  // zodResolver, but anyone bypassing the form (or a stale build) lands here.
  const parsed = signupInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION', message: 'กรุณากรอกข้อมูลให้ครบถ้วน' };
  }

  let result: SignupResponse;
  try {
    result = await api.post('/auth/signup', parsed.data, signupResponseSchema);
  } catch (err) {
    return mapApiError(err);
  }

  // Same envelope as login: httpOnly cookies, secure in production.
  await setAuthCookies({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt,
  });

  // `redirect()` throws — this never returns. Welcome page reads the slug
  // from search params (cookie also has the JWT, but slug-in-URL keeps the
  // welcome page bookmarkable + shareable for screenshots / support).
  redirect(`/signup/welcome?slug=${encodeURIComponent(result.companySlug)}`);
}

/**
 * Slug availability probe. Used by the form to render live feedback as the
 * admin types — debounced client-side. Returns the API's discriminated union
 * unchanged (callers reason about `available + reason`).
 *
 * Errors (network / unknown) map to a synthetic "couldn't check" result —
 * the form treats those the same as "available unless proven otherwise" so
 * a flaky network never blocks form submission. Server will re-check at
 * submit time anyway.
 */
export async function checkSlugAction(slug: string): Promise<CheckSlugResponse> {
  const parsed = checkSlugInputSchema.safeParse({ slug });
  if (!parsed.success) {
    // Empty / too long — UX matches the API's response shape so the form
    // doesn't have to special-case validation errors.
    return { available: false, reason: slug.length > 64 ? 'too_long' : 'too_short' };
  }
  try {
    return await api.get(
      `/auth/check-slug?slug=${encodeURIComponent(parsed.data.slug)}`,
      checkSlugResponseSchema,
    );
  } catch (err) {
    // Best-effort — don't block typing on a network blip. Logged for ops.
    console.error('[signup/check-slug] probe failed:', err);
    // Optimistic "available" to keep the form usable; submit will re-check.
    return { available: true };
  }
}

function mapApiError(err: unknown): SignupActionResult {
  if (err instanceof ApiError) {
    if (err.statusCode === 400 && err.code === 'BadRequestException') {
      return {
        ok: false,
        code: 'INVALID_SLUG',
        message: err.message || 'รหัสหอพักไม่ถูกต้อง — กรุณาตรวจสอบและลองอีกครั้ง',
      };
    }
    if (err.statusCode === 409 || err.code === 'ConflictException') {
      return {
        ok: false,
        code: 'SLUG_TAKEN',
        message: 'รหัสหอพักนี้ถูกใช้แล้ว — กรุณาเลือกชื่ออื่น',
      };
    }
    if (err.code === 'NetworkError') {
      return {
        ok: false,
        code: 'NETWORK',
        message: 'การเชื่อมต่อมีปัญหา กรุณาลองใหม่',
      };
    }
  }
  console.error('[signup] unexpected error:', err);
  return {
    ok: false,
    code: 'UNKNOWN',
    message: 'เกิดข้อผิดพลาดในการสมัคร — กรุณาลองใหม่ภายหลัง',
  };
}
