'use server';

import { ApiError, api } from '@/lib/api';
import { clearAuthCookies, setAuthCookies } from '@/lib/cookies';
import {
  type AuthTokens,
  type LoginAdminInput,
  authTokensSchema,
  loginAdminInputSchema,
} from '@dorm/shared/zod';
import { redirect } from 'next/navigation';

/**
 * Server Actions for the admin auth flow.
 *
 * These run on the server (never in the browser) so:
 *   1. The JWT_SECRET stays server-side,
 *   2. The Set-Cookie header is httpOnly — the browser can't read the JWT,
 *   3. We can `redirect()` (Next intercepts the throw + emits a redirect).
 *
 * Caller pattern (Client Component):
 *
 *   const result = await loginAction(values, next);
 *   if (result && !result.ok) setError(result.message);
 *   // on success: redirect throws — we never reach this branch.
 */

/** Discriminated union the client narrows on. */
export type LoginActionResult =
  | {
      ok: false;
      code: 'VALIDATION' | 'INVALID_CREDENTIALS' | 'NETWORK' | 'UNKNOWN';
      message: string;
    }
  // Success path is unreachable — `redirect()` throws a NEXT_REDIRECT signal.
  // The variant exists so the return type is a complete union for narrowing.
  | { ok: true };

/**
 * loginAction — POST /auth/login → set cookies → redirect.
 *
 * @param input  Form values (re-validated server-side against the canonical
 *               shared schema; never trust the client-side parse).
 * @param next   Optional return path from middleware (`?next=/c/abc/...`).
 *               Sanitised below to prevent open-redirect attacks — must be
 *               same-origin AND under the user's own /c/[companySlug]/ tree.
 */
export async function loginAction(
  input: LoginAdminInput,
  next?: string,
): Promise<LoginActionResult> {
  const parsed = loginAdminInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'กรุณากรอกข้อมูลให้ครบถ้วน',
    };
  }

  let tokens: AuthTokens;
  try {
    tokens = await api.post('/auth/login', parsed.data, authTokensSchema);
  } catch (err) {
    if (err instanceof ApiError) {
      // apps/api throws UnauthorizedException for ALL credential failures
      // (missing user, wrong password, inactive user, no roles) — we don't
      // distinguish to avoid user enumeration.
      if (err.statusCode === 401 || err.code === 'UnauthorizedException') {
        return {
          ok: false,
          code: 'INVALID_CREDENTIALS',
          message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
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
    console.error('[auth/login] unexpected error:', err);
    return { ok: false, code: 'UNKNOWN', message: 'เกิดข้อผิดพลาด กรุณาลองใหม่' };
  }

  await setAuthCookies(tokens);

  // Honour `next` only if it's safe — defaults to dashboard otherwise.
  const target = isSafeNextPath(next, parsed.data.companySlug)
    ? (next as string)
    : `/c/${parsed.data.companySlug}/dashboard`;
  redirect(target);
}

/** Clear cookies + bounce to /login. */
export async function logoutAction(): Promise<void> {
  await clearAuthCookies();
  redirect('/login');
}

/**
 * Open-redirect guard. We accept `next` only when it:
 *   1. Starts with /c/ (admin app surface — never raw external URLs),
 *   2. Targets the *signed-in user's* company (no cross-tenant nav),
 *   3. Is a path (no scheme/host — protocol-relative URLs are rejected).
 */
function isSafeNextPath(next: string | undefined, companySlug: string): boolean {
  if (!next) return false;
  if (next.startsWith('//') || next.includes('://')) return false;
  const expectedPrefix = `/c/${companySlug}`;
  return next === expectedPrefix || next.startsWith(`${expectedPrefix}/`);
}
