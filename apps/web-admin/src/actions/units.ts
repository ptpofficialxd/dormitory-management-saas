'use server';

import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { type CreateUnitInput, createUnitInputSchema, unitWireSchema } from '@/queries/units';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

/**
 * Server Actions for unit mutations. Mirrors `actions/properties.ts`.
 */

export type CreateUnitResult =
  | {
      ok: false;
      code: 'VALIDATION' | 'CONFLICT' | 'FORBIDDEN' | 'NETWORK' | 'UNKNOWN';
      message: string;
    }
  | { ok: true };

export async function createUnitAction(
  companySlug: string,
  input: CreateUnitInput,
): Promise<CreateUnitResult> {
  const parsed = createUnitInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'กรุณากรอกข้อมูลให้ครบถ้วนและถูกต้อง',
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
    await api.post(`/c/${companySlug}/units`, parsed.data, unitWireSchema, { token });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.statusCode === 409 || err.code === 'ConflictException') {
        return {
          ok: false,
          code: 'CONFLICT',
          message: 'หมายเลขห้องนี้ถูกใช้แล้วในอาคารนี้',
        };
      }
      if (err.statusCode === 403 || err.code === 'ForbiddenException') {
        return {
          ok: false,
          code: 'FORBIDDEN',
          message: 'คุณไม่มีสิทธิ์สร้างห้อง — ติดต่อเจ้าของหอ',
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
    console.error('[units/create] unexpected error:', err);
    return { ok: false, code: 'UNKNOWN', message: 'เกิดข้อผิดพลาด กรุณาลองใหม่' };
  }

  revalidatePath(`/c/${companySlug}/units`);
  redirect(`/c/${companySlug}/units`);
}
