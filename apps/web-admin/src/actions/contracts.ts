'use server';

import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import {
  type CreateContractInput,
  type UpdateContractInput,
  contractWireSchema,
  createContractInputSchema,
  updateContractInputSchema,
} from '@/queries/contracts';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

/**
 * Server Actions for contract mutations.
 *
 * Mirrors `actions/tenants.ts` (Task #79) — same defence-in-depth posture
 * (re-validate with shared schema → call API with httpOnly-cookie JWT →
 * map ApiError to a discriminated-union return type → revalidate caches).
 *
 * No deleteContractAction — Contract cascades into Invoice / Payment.
 * Use `updateContractAction({ status: 'terminated' })` to retire early
 * or `'ended'` for natural expiry; the audit log preserves history.
 */

export type ContractActionResult =
  | {
      ok: false;
      code:
        | 'VALIDATION'
        | 'CONFLICT'
        | 'FORBIDDEN'
        | 'NOT_FOUND'
        | 'NETWORK'
        | 'OVERLAP'
        | 'UNKNOWN';
      message: string;
    }
  | { ok: true };

export async function createContractAction(
  companySlug: string,
  input: CreateContractInput,
): Promise<ContractActionResult> {
  const parsed = createContractInputSchema.safeParse(input);
  if (!parsed.success) {
    // Surface the most useful error (the .refine on endDate > startDate is
    // common enough to call out specifically; everything else lumped).
    const firstIssue = parsed.error.issues[0];
    const isEndDateRefine = firstIssue?.path.join('.') === 'endDate';
    return {
      ok: false,
      code: 'VALIDATION',
      message: isEndDateRefine ? 'วันสิ้นสุดต้องอยู่หลังวันเริ่ม' : 'กรุณาตรวจสอบข้อมูลที่กรอก',
    };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) {
    return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };
  }

  try {
    await api.post(`/c/${companySlug}/contracts`, parsed.data, contractWireSchema, { token });
  } catch (err) {
    return mapContractApiError(err, 'สร้างสัญญาไม่สำเร็จ');
  }

  revalidatePath(`/c/${companySlug}/contracts`);
  redirect(`/c/${companySlug}/contracts`);
}

/**
 * PATCH /c/:slug/contracts/:id — partial update of `status` / `endDate` /
 * `notes`. The API's `updateContractInputSchema` is narrow on purpose
 * (no rentAmount edits — it's a snapshot at create time).
 *
 * Used for both:
 *   - "ยืนยันสัญญา" button (draft → active)
 *   - "สิ้นสุดสัญญา" / "ยกเลิกก่อนกำหนด" actions
 *   - Inline notes edit on detail page
 *
 * Caller decides navigation; we just revalidate and return.
 */
export async function updateContractAction(
  companySlug: string,
  contractId: string,
  input: UpdateContractInput,
): Promise<ContractActionResult> {
  const parsed = updateContractInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION', message: 'กรุณาตรวจสอบข้อมูลที่กรอก' };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) {
    return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };
  }

  try {
    await api.patch(`/c/${companySlug}/contracts/${contractId}`, parsed.data, contractWireSchema, {
      token,
    });
  } catch (err) {
    return mapContractApiError(err, 'อัปเดตสัญญาไม่สำเร็จ');
  }

  revalidatePath(`/c/${companySlug}/contracts`);
  revalidatePath(`/c/${companySlug}/contracts/${contractId}`);
  return { ok: true };
}

/** Translate ApiError → typed discriminated-union shape. */
function mapContractApiError(err: unknown, fallbackMessage: string): ContractActionResult {
  if (err instanceof ApiError) {
    if (err.statusCode === 404 || err.code === 'NotFoundException') {
      return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบสัญญานี้' };
    }
    // The service throws 409 ContractOverlap when the unit already has a
    // draft/active contract for the requested period — surface clearly so
    // admin knows to terminate the old one first.
    if (err.code === 'ContractOverlap') {
      return {
        ok: false,
        code: 'OVERLAP',
        message: 'ห้องนี้มีสัญญาที่ยังใช้งานหรือร่างอยู่ — ปิดสัญญาเดิมก่อน',
      };
    }
    if (err.statusCode === 409 || err.code === 'ConflictException') {
      return {
        ok: false,
        code: 'CONFLICT',
        message: err.message || 'ดำเนินการไม่ได้ ขัดแย้งกับสถานะปัจจุบัน',
      };
    }
    if (err.statusCode === 403 || err.code === 'ForbiddenException') {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'คุณไม่มีสิทธิ์ดำเนินการนี้ — ติดต่อเจ้าของหอ',
      };
    }
    if (err.code === 'NetworkError') {
      return { ok: false, code: 'NETWORK', message: 'การเชื่อมต่อมีปัญหา กรุณาลองใหม่' };
    }
  }
  console.error('[contracts/action] unexpected error:', err);
  return { ok: false, code: 'UNKNOWN', message: fallbackMessage };
}
