'use server';

import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import {
  type UpsertCompanyLineChannelInput,
  companyLineChannelPublicWireSchema,
  upsertCompanyLineChannelInputSchema,
} from '@/queries/line-channel';
import { revalidatePath } from 'next/cache';

/**
 * Server Action for the LINE OA channel upsert (Task #109).
 *
 * Backend uses PUT /c/:slug/line-channel + plaintext secrets in the body —
 * the API encrypts at rest via pgcrypto (see CompanyLineChannelService).
 * Plaintext travels HTTPS-only and never touches our server logs.
 *
 * Mirrors actions/company.ts shape: discriminated-union result, friendly
 * Thai error messages, revalidate the settings path so the GET re-renders
 * with hasChannelSecret/hasChannelAccessToken=true after save.
 */

export type LineChannelActionResult =
  | {
      ok: false;
      code: 'VALIDATION' | 'CONFLICT' | 'FORBIDDEN' | 'NETWORK' | 'UNKNOWN';
      message: string;
    }
  | { ok: true };

export async function upsertLineChannelAction(
  companySlug: string,
  input: UpsertCompanyLineChannelInput,
): Promise<LineChannelActionResult> {
  const parsed = upsertCompanyLineChannelInputSchema.safeParse(input);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const fieldPath = firstIssue?.path.join('.') ?? '';
    return {
      ok: false,
      code: 'VALIDATION',
      message: fieldHint(fieldPath),
    };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) {
    return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };
  }

  try {
    await api.put(
      `/c/${companySlug}/line-channel`,
      parsed.data,
      companyLineChannelPublicWireSchema,
      { token },
    );
  } catch (err) {
    return mapApiError(err);
  }

  revalidatePath(`/c/${companySlug}/settings`);
  return { ok: true };
}

function fieldHint(path: string): string {
  switch (path) {
    case 'channelId':
      return 'Channel ID ต้องเป็นตัวเลข 9–10 หลัก (จาก LINE Developers Console)';
    case 'channelSecret':
      return 'Channel Secret ต้องเป็น hex 32 ตัวอักษร';
    case 'channelAccessToken':
      return 'Channel Access Token ไม่ถูกต้อง — ตรวจจาก LINE Developers Console';
    case 'basicId':
      return 'LINE Basic ID ต้องขึ้นต้นด้วย @ ตามด้วยตัวอักษร 4–18 ตัว';
    default:
      return 'กรุณาตรวจสอบข้อมูลที่กรอก';
  }
}

function mapApiError(err: unknown): LineChannelActionResult {
  if (err instanceof ApiError) {
    if (err.statusCode === 401 || err.code === 'UnauthorizedException') {
      return { ok: false, code: 'FORBIDDEN', message: 'หมดอายุการเข้าสู่ระบบ — กรุณาเข้าใหม่' };
    }
    if (err.statusCode === 403 || err.code === 'ForbiddenException') {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'เฉพาะเจ้าของหอ + ผู้จัดการเท่านั้นที่ตั้งค่า LINE OA ได้',
      };
    }
    if (err.statusCode === 409 || err.code === 'ConflictException') {
      return {
        ok: false,
        code: 'CONFLICT',
        message: 'Channel ID นี้ถูกใช้กับหอพักอื่นแล้ว — ใช้ LINE OA แยกต่อหอ',
      };
    }
    if (err.code === 'NetworkError') {
      return { ok: false, code: 'NETWORK', message: 'เครือข่ายมีปัญหา — กรุณาลองใหม่' };
    }
  }
  console.error('[line-channel] unexpected error:', err);
  return { ok: false, code: 'UNKNOWN', message: 'บันทึก LINE OA ไม่สำเร็จ' };
}
