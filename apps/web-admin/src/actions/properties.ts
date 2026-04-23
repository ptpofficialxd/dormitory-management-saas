'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import {
  type CreatePropertyInput,
  createPropertyInputSchema,
  propertyWireSchema,
} from '@/queries/properties';

/**
 * Server Actions for property mutations.
 *
 * Pattern (re-used from `actions/auth.ts`):
 *   1. Re-validate input with the canonical shared schema (defence in depth —
 *      never trust the client parse).
 *   2. Call apps/api with the JWT pulled from the httpOnly cookie.
 *   3. On success → revalidatePath() to refresh the list, then redirect.
 *   4. On failure → return a typed discriminated union the client narrows on.
 */

export type CreatePropertyResult =
  | {
      ok: false;
      code: 'VALIDATION' | 'CONFLICT' | 'FORBIDDEN' | 'NETWORK' | 'UNKNOWN';
      message: string;
    }
  // Success path is unreachable — `redirect()` throws NEXT_REDIRECT.
  | { ok: true };

export async function createPropertyAction(
  companySlug: string,
  input: CreatePropertyInput,
): Promise<CreatePropertyResult> {
  const parsed = createPropertyInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'กรุณากรอกข้อมูลให้ครบถ้วน',
    };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'กรุณาเข้าสู่ระบบใหม่',
    };
  }

  try {
    await api.post(
      `/c/${companySlug}/properties`,
      parsed.data,
      propertyWireSchema,
      { token },
    );
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.statusCode === 409 || err.code === 'ConflictException') {
        return {
          ok: false,
          code: 'CONFLICT',
          message: 'รหัสอาคารนี้ถูกใช้แล้วในระบบ',
        };
      }
      if (err.statusCode === 403 || err.code === 'ForbiddenException') {
        return {
          ok: false,
          code: 'FORBIDDEN',
          message: 'คุณไม่มีสิทธิ์สร้างอาคาร — ติดต่อเจ้าของหอ',
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
    console.error('[properties/create] unexpected error:', err);
    return { ok: false, code: 'UNKNOWN', message: 'เกิดข้อผิดพลาด กรุณาลองใหม่' };
  }

  // Bust the route cache for the list page so the new row shows immediately
  // on redirect (otherwise Next would serve a stale Server Component render).
  revalidatePath(`/c/${companySlug}/properties`);
  redirect(`/c/${companySlug}/properties`);
}
