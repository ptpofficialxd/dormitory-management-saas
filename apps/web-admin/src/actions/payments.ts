'use server';

import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { paymentWireSchema } from '@/queries/payments';
import { slipViewUrlWireSchema, slipWireSchema } from '@/queries/slips';
import { confirmPaymentInputSchema, rejectPaymentInputSchema } from '@dorm/shared/zod';
import { revalidatePath } from 'next/cache';

/**
 * Server Actions for payment + slip review mutations.
 *
 * Same discriminated-union shape as actions/invoices.ts:
 * `{ ok: false, code, message } | { ok: true, ... }`. The slip view-URL
 * action returns the resolved URL because the Client Component needs to
 * render an <img src> after the user expands a row.
 */

export type PaymentActionResult =
  | {
      ok: false;
      code: 'VALIDATION' | 'CONFLICT' | 'FORBIDDEN' | 'NETWORK' | 'NOT_FOUND' | 'UNKNOWN';
      message: string;
    }
  | { ok: true };

export type SlipViewUrlResult =
  | {
      ok: false;
      code: 'NOT_FOUND' | 'FORBIDDEN' | 'NETWORK' | 'UNKNOWN';
      message: string;
    }
  | { ok: true; url: string; expiresAt: Date };

/**
 * Confirm a pending payment -> mark Invoice (partially_)paid downstream.
 * The optional `note` is forwarded to the audit log.
 */
export async function confirmPaymentAction(
  companySlug: string,
  paymentId: string,
  note?: string,
): Promise<PaymentActionResult> {
  const parsed = confirmPaymentInputSchema.safeParse({ note });
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION', message: 'หมายเหตุยาวเกินกำหนด (สูงสุด 512 อักขระ)' };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };

  try {
    await api.post(
      `/c/${companySlug}/payments/${paymentId}/confirm`,
      parsed.data,
      paymentWireSchema,
      { token },
    );
  } catch (err) {
    return mapApiError(err, 'ยืนยันการชำระไม่สำเร็จ');
  }

  revalidatePath(`/c/${companySlug}/payments`);
  return { ok: true };
}

/**
 * Reject a pending payment with a mandatory reason (1–512 chars). The
 * tenant gets a LINE notification downstream so they know to resubmit.
 */
export async function rejectPaymentAction(
  companySlug: string,
  paymentId: string,
  rejectionReason: string,
): Promise<PaymentActionResult> {
  const parsed = rejectPaymentInputSchema.safeParse({ rejectionReason });
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION', message: 'กรุณาระบุเหตุผลการปฏิเสธ (1–512 อักขระ)' };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };

  try {
    await api.post(
      `/c/${companySlug}/payments/${paymentId}/reject`,
      parsed.data,
      paymentWireSchema,
      { token },
    );
  } catch (err) {
    return mapApiError(err, 'ปฏิเสธการชำระไม่สำเร็จ');
  }

  revalidatePath(`/c/${companySlug}/payments`);
  return { ok: true };
}

/**
 * Two-hop fetch to mint a short-TTL signed GET URL for the slip image:
 *   1. GET /payments/:paymentId/slip   -> slip metadata (id)
 *   2. GET /slips/:id/view-url         -> { url, expiresAt }
 *
 * Done as a Server Action (not a Route Handler) so the JWT cookie never
 * leaves the server. The Client Component calls this on row-expand and
 * renders an <img src={url} />. URL TTL is ~5 min per CLAUDE.md §3 #9 —
 * the Client must NOT cache it; mint fresh per view.
 */
export async function getSlipViewUrlAction(
  companySlug: string,
  paymentId: string,
): Promise<SlipViewUrlResult> {
  const token = await getAccessTokenFromCookie();
  if (!token) return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };

  try {
    const slip = await api.get(`/c/${companySlug}/payments/${paymentId}/slip`, slipWireSchema, {
      token,
    });
    const view = await api.get(
      `/c/${companySlug}/slips/${slip.id}/view-url`,
      slipViewUrlWireSchema,
      {
        token,
      },
    );
    return { ok: true, url: view.url, expiresAt: view.expiresAt };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.statusCode === 404 || err.code === 'NotFoundException') {
        return { ok: false, code: 'NOT_FOUND', message: 'ผู้เช่ายังไม่ได้ส่งสลิปสำหรับรายการนี้' };
      }
      if (err.statusCode === 403 || err.code === 'ForbiddenException') {
        return { ok: false, code: 'FORBIDDEN', message: 'คุณไม่มีสิทธิ์ดูสลิปนี้' };
      }
      if (err.code === 'NetworkError') {
        return { ok: false, code: 'NETWORK', message: 'การเชื่อมต่อมีปัญหา กรุณาลองใหม่' };
      }
    }
    console.error('[payments/view-slip] unexpected error:', err);
    return { ok: false, code: 'UNKNOWN', message: 'ไม่สามารถโหลดสลิปได้' };
  }
}

function mapApiError(err: unknown, fallbackMessage: string): PaymentActionResult {
  if (err instanceof ApiError) {
    if (err.statusCode === 404 || err.code === 'NotFoundException') {
      return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการชำระ' };
    }
    if (err.statusCode === 409 || err.code === 'ConflictException') {
      return {
        ok: false,
        code: 'CONFLICT',
        message: 'สถานะของรายการเปลี่ยนไปแล้ว กรุณารีเฟรช',
      };
    }
    if (err.statusCode === 403 || err.code === 'ForbiddenException') {
      return { ok: false, code: 'FORBIDDEN', message: 'คุณไม่มีสิทธิ์ดำเนินการนี้' };
    }
    if (err.code === 'NetworkError') {
      return { ok: false, code: 'NETWORK', message: 'การเชื่อมต่อมีปัญหา กรุณาลองใหม่' };
    }
  }
  console.error('[payments/action] unexpected error:', err);
  return { ok: false, code: 'UNKNOWN', message: fallbackMessage };
}
