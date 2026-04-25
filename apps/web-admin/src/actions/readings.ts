'use server';

import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import {
  type CreateReadingInput,
  type ReadingWire,
  type UpdateReadingInput,
  createReadingInputSchema,
  readingWireSchema,
  updateReadingInputSchema,
} from '@/queries/readings';
import { revalidatePath } from 'next/cache';

/**
 * Server Actions for reading mutations.
 *
 * Mirrors `actions/tenants.ts` / `actions/contracts.ts`:
 *   1. Re-validate input with the canonical shared schema (defence in depth).
 *   2. Call apps/api with the JWT pulled from the httpOnly cookie.
 *   3. On success → revalidatePath() + return ok (the grid stays put;
 *      it patches its own row state from the response).
 *   4. On failure → return a typed discriminated union the client narrows on.
 *
 * No deleteReadingAction — Reading is referenced by InvoiceItem once an
 * invoice is generated. Use updateReadingAction to correct (rare, audit
 * trail preserves history). Same shape decision as ReadingController.
 *
 * The grid posts one row at a time (not batch) so each row gets independent
 * feedback — staff doing the monthly meter walk shouldn't lose 39 saved rows
 * because the 40th row failed validation.
 *
 * Error codes the grid cares about:
 *   - NEGATIVE_CONSUMPTION → service rejected because current < previous
 *   - ALREADY_EXISTS       → race: another tab/user already entered this
 *                            (meter, period). Caller refetches to recover.
 */

export type ReadingActionResult =
  | {
      ok: false;
      code:
        | 'VALIDATION'
        | 'NEGATIVE_CONSUMPTION'
        | 'ALREADY_EXISTS'
        | 'FORBIDDEN'
        | 'NOT_FOUND'
        | 'NETWORK'
        | 'UNKNOWN';
      message: string;
    }
  | {
      ok: true;
      // Return the freshly-saved row so the grid can swap state without
      // a refetch round-trip. Also bumps the consumption display.
      reading: {
        id: string;
        meterId: string;
        period: string;
        valueCurrent: string;
        valuePrevious: string;
        consumption: string;
        photoKey: string | null;
        readAt: string;
      };
    };

export async function createReadingAction(
  companySlug: string,
  input: CreateReadingInput,
): Promise<ReadingActionResult> {
  const parsed = createReadingInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION', message: 'กรุณากรอกค่ามิเตอร์ให้ถูกต้อง' };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) {
    return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };
  }

  let saved: ReadingWire;
  try {
    saved = await api.post(`/c/${companySlug}/readings`, parsed.data, readingWireSchema, {
      token,
    });
  } catch (err) {
    return mapReadingApiError(err, 'บันทึกค่ามิเตอร์ไม่สำเร็จ');
  }

  // Bust the readings list cache — caller stays on /readings so we don't
  // redirect, but a fresh navigation should reflect the saved row.
  revalidatePath(`/c/${companySlug}/readings`);

  return { ok: true, reading: projectReading(saved) };
}

/**
 * PATCH /c/:slug/readings/:id — used to correct a typo on a previously-saved
 * reading. Service recomputes consumption against the STORED valuePrevious
 * (not re-resolved) so the audit trail stays honest.
 */
export async function updateReadingAction(
  companySlug: string,
  readingId: string,
  input: UpdateReadingInput,
): Promise<ReadingActionResult> {
  const parsed = updateReadingInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION', message: 'กรุณาตรวจสอบค่าที่กรอก' };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) {
    return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };
  }

  let saved: ReadingWire;
  try {
    saved = await api.patch(
      `/c/${companySlug}/readings/${readingId}`,
      parsed.data,
      readingWireSchema,
      { token },
    );
  } catch (err) {
    return mapReadingApiError(err, 'อัปเดตค่ามิเตอร์ไม่สำเร็จ');
  }

  revalidatePath(`/c/${companySlug}/readings`);

  return { ok: true, reading: projectReading(saved) };
}

/**
 * Project the wire schema down to the small payload the grid needs. Decimal
 * fields are already strings per `meterValueSchema`, so no Number coercion —
 * passing the runtime value straight through preserves the canonical
 * normalised form (e.g. `"123.40"` not `"123.4"`).
 */
function projectReading(r: ReadingWire): {
  id: string;
  meterId: string;
  period: string;
  valueCurrent: string;
  valuePrevious: string;
  consumption: string;
  photoKey: string | null;
  readAt: string;
} {
  return {
    id: r.id,
    meterId: r.meterId,
    period: r.period,
    valueCurrent: r.valueCurrent,
    valuePrevious: r.valuePrevious,
    consumption: r.consumption,
    photoKey: r.photoKey,
    readAt: r.readAt,
  };
}

/**
 * Translate ApiError → typed discriminated-union shape.
 *
 * The Reading service throws structured exceptions with explicit `error`
 * codes (e.g. `NegativeConsumption`, `ReadingAlreadyExists`,
 * `InvalidMeterId`). GlobalExceptionFilter forwards `obj.error` into the
 * envelope's `error` field — which the api.ts wrapper surfaces as
 * `ApiError.code`. We branch on `code` first (stable identifier) and only
 * fall back to status-code branches for plain HttpException throws.
 */
function mapReadingApiError(err: unknown, fallbackMessage: string): ReadingActionResult {
  if (err instanceof ApiError) {
    // Service-level structured codes — these are the contract between
    // ReadingService and this action. Add a new case here whenever the
    // service grows a new `error` discriminator.
    if (err.code === 'NegativeConsumption') {
      return {
        ok: false,
        code: 'NEGATIVE_CONSUMPTION',
        message: 'ค่าใหม่ต้องไม่น้อยกว่าค่าก่อนหน้า — มิเตอร์เดินถอยหลังไม่ได้',
      };
    }
    if (err.code === 'ReadingAlreadyExists') {
      // (meterId, period) unique race — another admin tab/user just saved.
      return {
        ok: false,
        code: 'ALREADY_EXISTS',
        message: 'มีคนกรอกค่ามิเตอร์รอบนี้ไปแล้ว — กรุณารีเฟรชหน้า',
      };
    }
    if (err.code === 'InvalidMeterId') {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: 'ไม่พบมิเตอร์นี้ — อาจถูกลบหรือย้ายไปอาคารอื่น',
      };
    }

    // Generic HTTP-status fallbacks for anything not service-tagged.
    if (err.statusCode === 400) {
      return { ok: false, code: 'VALIDATION', message: err.message || fallbackMessage };
    }
    if (err.statusCode === 404 || err.code === 'NotFoundException') {
      return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบ reading นี้' };
    }
    if (err.statusCode === 409 || err.code === 'ConflictException') {
      return {
        ok: false,
        code: 'ALREADY_EXISTS',
        message: 'มีคนกรอกค่ามิเตอร์รอบนี้ไปแล้ว — กรุณารีเฟรชหน้า',
      };
    }
    if (err.statusCode === 403 || err.code === 'ForbiddenException') {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'คุณไม่มีสิทธิ์บันทึกค่ามิเตอร์ — ติดต่อเจ้าของหอ',
      };
    }
    if (err.code === 'NetworkError') {
      return { ok: false, code: 'NETWORK', message: 'การเชื่อมต่อมีปัญหา กรุณาลองใหม่' };
    }
  }
  console.error('[readings/action] unexpected error:', err);
  return { ok: false, code: 'UNKNOWN', message: fallbackMessage };
}
