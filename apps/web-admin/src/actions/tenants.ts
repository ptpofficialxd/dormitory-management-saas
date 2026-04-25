'use server';

import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import {
  type CreateTenantInput,
  type UpdateTenantInput,
  createTenantInputSchema,
  tenantWireSchema,
  updateTenantInputSchema,
} from '@/queries/tenants';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

/**
 * Server Actions for tenant mutations.
 *
 * Mirrors `actions/properties.ts` (Task #62):
 *   1. Re-validate input with the canonical shared schema (defence in depth
 *      — never trust the client parse).
 *   2. Call apps/api with the JWT pulled from the httpOnly cookie.
 *   3. On success → revalidatePath() + redirect (createTenantAction) OR
 *      revalidatePath() + return ok (updateTenantAction — caller chooses
 *      navigation; status-change usually stays on the detail page).
 *   4. On failure → return a typed discriminated union the client narrows on.
 *
 * No deleteTenantAction — Tenant cascades into Contract / Payment / Invoice
 * (FK Restrict). Use `updateTenantAction({ status: "moved_out" })` to retire
 * a row; the audit log preserves history. UX choice confirmed with Ice.
 */

export type TenantActionResult =
  | {
      ok: false;
      code: 'VALIDATION' | 'CONFLICT' | 'FORBIDDEN' | 'NOT_FOUND' | 'NETWORK' | 'UNKNOWN';
      message: string;
    }
  // Success path: the createTenant action redirects, so caller never sees this
  // branch from create. update returns it because the page stays put.
  | { ok: true };

export async function createTenantAction(
  companySlug: string,
  input: CreateTenantInput,
): Promise<TenantActionResult> {
  const parsed = createTenantInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION', message: 'กรุณากรอกข้อมูลให้ครบถ้วน' };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) {
    return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };
  }

  try {
    await api.post(`/c/${companySlug}/tenants`, parsed.data, tenantWireSchema, { token });
  } catch (err) {
    return mapTenantApiError(err, 'สร้างผู้เช่าไม่สำเร็จ');
  }

  // Bust the route cache for the list page so the new row shows immediately
  // on redirect (otherwise Next would serve a stale Server Component render).
  revalidatePath(`/c/${companySlug}/tenants`);
  redirect(`/c/${companySlug}/tenants`);
}

/**
 * PATCH /c/:slug/tenants/:id — partial update.
 *
 * Used for both the edit form (display name, phone, etc.) AND the status
 * dropdown (`{ status: 'moved_out' }` etc.) — the same endpoint covers
 * both because the API's `updateTenantInputSchema` is `.partial()`.
 *
 * Caller decides navigation: status-change typically stays on the detail
 * page (revalidate + return), edit form may redirect back to the list.
 * We keep this action navigation-free and let the caller `redirect()`
 * after the result if they want.
 */
export async function updateTenantAction(
  companySlug: string,
  tenantId: string,
  input: UpdateTenantInput,
): Promise<TenantActionResult> {
  const parsed = updateTenantInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION', message: 'กรุณาตรวจสอบข้อมูลที่กรอก' };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) {
    return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };
  }

  try {
    await api.patch(`/c/${companySlug}/tenants/${tenantId}`, parsed.data, tenantWireSchema, {
      token,
    });
  } catch (err) {
    return mapTenantApiError(err, 'อัปเดตผู้เช่าไม่สำเร็จ');
  }

  // Refresh both the list page (status badge / display name) and the detail
  // page (which the caller is probably staying on after status change).
  revalidatePath(`/c/${companySlug}/tenants`);
  revalidatePath(`/c/${companySlug}/tenants/${tenantId}`);
  return { ok: true };
}

/** Translate ApiError → typed discriminated-union shape. Same shape as Properties. */
function mapTenantApiError(err: unknown, fallbackMessage: string): TenantActionResult {
  if (err instanceof ApiError) {
    if (err.statusCode === 404 || err.code === 'NotFoundException') {
      return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบผู้เช่ารายนี้' };
    }
    if (err.statusCode === 409 || err.code === 'ConflictException') {
      // Tenant unique constraint violation (e.g. duplicate lineUserId
      // within the company) — surface a friendly hint.
      return {
        ok: false,
        code: 'CONFLICT',
        message: 'ข้อมูลผู้เช่านี้ถูกใช้แล้ว (อาจถูกผูกบัญชี LINE ที่อื่น)',
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
  console.error('[tenants/action] unexpected error:', err);
  return { ok: false, code: 'UNKNOWN', message: fallbackMessage };
}
