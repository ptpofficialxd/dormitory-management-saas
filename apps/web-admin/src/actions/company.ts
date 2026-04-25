'use server';

import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import {
  type UpdatePromptPaySettingsInput,
  companyWireSchema,
  updatePromptPaySettingsInputSchema,
} from '@/queries/company';
import { revalidatePath } from 'next/cache';

/**
 * Server Actions for company config mutations.
 *
 * Mirrors `actions/tenants.ts` / `actions/contracts.ts` (Tasks #79, #80).
 *
 * No `redirect()` here — Settings stays put after save (admin wants to
 * confirm the value persisted, not be bounced back to the dashboard).
 */

export type CompanyActionResult =
  | {
      ok: false;
      code: 'VALIDATION' | 'FORBIDDEN' | 'NETWORK' | 'UNKNOWN';
      message: string;
    }
  | { ok: true };

/**
 * `PUT /c/:slug/prompt-pay` — set the PromptPay payee config.
 *
 * Both fields required by the shared schema. Owner-only via
 * `@Perm('update', 'company')` on the API; UI mirrors with
 * `<Can action="update" resource="company">` to hide the form for
 * non-owner roles.
 */
export async function setPromptPayAction(
  companySlug: string,
  input: UpdatePromptPaySettingsInput,
): Promise<CompanyActionResult> {
  const parsed = updatePromptPaySettingsInputSchema.safeParse(input);
  if (!parsed.success) {
    // Surface the first issue so the user knows which field is wrong.
    // Both fields have informative `.regex` messages — bubble those up.
    const firstIssue = parsed.error.issues[0];
    return {
      ok: false,
      code: 'VALIDATION',
      message: firstIssue?.message ?? 'กรุณาตรวจสอบข้อมูลที่กรอก',
    };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) {
    return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };
  }

  try {
    await api.put(`/c/${companySlug}/prompt-pay`, parsed.data, companyWireSchema, { token });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.statusCode === 403 || err.code === 'ForbiddenException') {
        return {
          ok: false,
          code: 'FORBIDDEN',
          message: 'เฉพาะเจ้าของหอเท่านั้นที่ตั้งค่า PromptPay ได้',
        };
      }
      if (err.code === 'NetworkError') {
        return { ok: false, code: 'NETWORK', message: 'การเชื่อมต่อมีปัญหา กรุณาลองใหม่' };
      }
    }
    console.error('[company/setPromptPay] unexpected error:', err);
    return { ok: false, code: 'UNKNOWN', message: 'บันทึกไม่สำเร็จ กรุณาลองใหม่' };
  }

  // Refresh the Settings page + the dashboard (which may show a "set
  // PromptPay first" banner that should disappear after this).
  revalidatePath(`/c/${companySlug}/settings`);
  revalidatePath(`/c/${companySlug}/dashboard`);
  return { ok: true };
}
