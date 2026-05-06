'use server';

import { randomUUID } from 'node:crypto';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import {
  type CreateAnnouncementInput,
  announcementWireSchema,
  createAnnouncementInputSchema,
} from '@/queries/announcements';
import { revalidatePath } from 'next/cache';

/**
 * Server Actions for announcement broadcast (Task #108).
 *
 * Mirrors actions/contracts.ts shape. v1 only exposes the "compose +
 * send now" path — scheduling lands in Phase 1.
 *
 * Idempotency-Key is generated server-side via `crypto.randomUUID()` so
 * the client form doesn't have to manage it. Trade-off: a Server Actions
 * framework retry (rare, but possible on edge networks) creates a new
 * row instead of collapsing — acceptable for MVP because the form's
 * `isSubmitting` flag prevents double-submit at the UI layer. Phase 1
 * wishlist: lift the key into a Client useState seeded once per form
 * mount so retries collapse cleanly.
 */

export type AnnouncementActionResult =
  | {
      ok: false;
      code:
        | 'VALIDATION'
        | 'CONFLICT'
        | 'FORBIDDEN'
        | 'NOT_FOUND'
        | 'NETWORK'
        | 'NO_RECIPIENTS'
        | 'NO_LINE_CHANNEL'
        | 'UNKNOWN';
      message: string;
    }
  | { ok: true; announcementId: string; status: string };

export async function createBroadcastAction(
  companySlug: string,
  input: CreateAnnouncementInput,
): Promise<AnnouncementActionResult> {
  const parsed = createAnnouncementInputSchema.safeParse(input);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const fieldPath = firstIssue?.path.join('.') ?? '';
    const fieldHint =
      fieldPath === 'title'
        ? 'หัวข้อต้องมีความยาว 1–128 ตัวอักษร'
        : fieldPath === 'body'
          ? 'เนื้อหาต้องมีความยาว 1–4,000 ตัวอักษร'
          : 'กรุณาตรวจสอบข้อมูลที่กรอก';
    return { ok: false, code: 'VALIDATION', message: fieldHint };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) {
    return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };
  }

  // randomUUID() → 36-char string, comfortably within the 8–128 controller limit.
  const idempotencyKey = randomUUID();

  let result: { id: string; status: string };
  try {
    const created = await api.post(
      `/c/${companySlug}/announcements`,
      parsed.data,
      announcementWireSchema,
      { token, idempotencyKey },
    );
    result = { id: created.id, status: created.status };
  } catch (err) {
    return mapAnnouncementApiError(err);
  }

  // List + detail might be open in another tab — invalidate both.
  revalidatePath(`/c/${companySlug}/announcements`);
  revalidatePath(`/c/${companySlug}/announcements/${result.id}`);

  return { ok: true, announcementId: result.id, status: result.status };
}

/**
 * Translate ApiError → typed discriminated-union shape. Surfaces the
 * v1-scope guards (UnsupportedAudience / UnsupportedSchedule) as
 * VALIDATION since they're really "you sent the wrong shape" from the
 * client's perspective.
 */
function mapAnnouncementApiError(err: unknown): AnnouncementActionResult {
  if (err instanceof ApiError) {
    if (err.statusCode === 401 || err.code === 'UnauthorizedException') {
      return { ok: false, code: 'FORBIDDEN', message: 'หมดอายุการเข้าสู่ระบบ — กรุณาเข้าใหม่' };
    }
    if (err.statusCode === 403 || err.code === 'ForbiddenException') {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'บัญชีของคุณไม่มีสิทธิ์ส่งประกาศ — ติดต่อเจ้าของหอเพื่อขอสิทธิ์',
      };
    }
    if (err.code === 'IdempotencyKeyRequired') {
      // Should be impossible (we always send the header) but surface it just in case.
      return { ok: false, code: 'UNKNOWN', message: 'ระบบส่งคำขอผิดพลาด — กรุณาลองใหม่' };
    }
    if (err.code === 'UnsupportedAudience' || err.code === 'UnsupportedSchedule') {
      return {
        ok: false,
        code: 'VALIDATION',
        message: 'รูปแบบประกาศนี้ยังไม่รองรับใน v1 — ตอนนี้ส่งได้เฉพาะ "ทุกคน + ส่งทันที"',
      };
    }
    // Pre-flight failures from the service — surface the API's Thai
    // message directly (it tells the admin exactly what to do next).
    if (err.code === 'NoLineChannel') {
      return {
        ok: false,
        code: 'NO_LINE_CHANNEL',
        message: err.message,
      };
    }
    if (err.code === 'NoRecipients') {
      return {
        ok: false,
        code: 'NO_RECIPIENTS',
        message: err.message,
      };
    }
    if (err.code === 'NetworkError') {
      return { ok: false, code: 'NETWORK', message: 'เครือข่ายมีปัญหา — กรุณาลองใหม่' };
    }
  }
  console.error('[announcements] unexpected error:', err);
  return { ok: false, code: 'UNKNOWN', message: 'ส่งประกาศไม่สำเร็จ' };
}
