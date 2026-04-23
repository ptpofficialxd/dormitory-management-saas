'use server';

import { randomUUID } from 'node:crypto';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import {
  type BatchGenerateInvoicesInput,
  type BatchGenerateInvoicesResultWire,
  batchGenerateInvoicesInputSchema,
  batchGenerateInvoicesResultWireSchema,
  invoiceWireSchema,
} from '@/queries/invoices';
import { issueInvoiceInputSchema, voidInvoiceInputSchema } from '@dorm/shared/zod';
import { revalidatePath } from 'next/cache';

/**
 * Server Actions for invoice mutations.
 *
 * Both actions follow the discriminated-union return shape from
 * `actions/properties.ts` (`{ ok: false, code, message } | { ok: true }`).
 * On success the caller decides whether to refresh / navigate / show toast.
 *
 * No `redirect()` here — these actions fire from the detail page itself,
 * so we just `revalidatePath()` the detail + list and let the page re-render
 * with the updated status.
 */

export type InvoiceActionResult =
  | {
      ok: false;
      code: 'VALIDATION' | 'CONFLICT' | 'FORBIDDEN' | 'NETWORK' | 'NOT_FOUND' | 'UNKNOWN';
      message: string;
    }
  | { ok: true };

/**
 * Transition `draft` → `issued`. The API enforces:
 * - Idempotent (re-issuing an already-issued invoice is a no-op)
 * - Only owner / property_manager via @Perm('approve','invoice')
 */
export async function issueInvoiceAction(
  companySlug: string,
  invoiceId: string,
): Promise<InvoiceActionResult> {
  const parsed = issueInvoiceInputSchema.safeParse({});
  if (!parsed.success) {
    // Should never happen — schema is .strict({}) — but guard anyway.
    return { ok: false, code: 'VALIDATION', message: 'รูปแบบคำขอไม่ถูกต้อง' };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) {
    return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };
  }

  try {
    await api.post(
      `/c/${companySlug}/invoices/${invoiceId}/issue`,
      parsed.data,
      invoiceWireSchema,
      { token },
    );
  } catch (err) {
    return mapApiError(err, 'ออกบิลไม่สำเร็จ');
  }

  revalidatePath(`/c/${companySlug}/invoices/${invoiceId}`);
  revalidatePath(`/c/${companySlug}/invoices`);
  return { ok: true };
}

/**
 * Cancel an invoice with a reason (4–512 chars per shared schema). Voiding
 * is irreversible at the data layer — the row stays for audit + receipt
 * history, just flagged `void` so it's excluded from outstanding balance.
 */
export async function voidInvoiceAction(
  companySlug: string,
  invoiceId: string,
  reason: string,
): Promise<InvoiceActionResult> {
  const parsed = voidInvoiceInputSchema.safeParse({ reason });
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'กรุณาระบุเหตุผลการยกเลิก (4–512 ตัวอักษร)',
    };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) {
    return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };
  }

  try {
    await api.post(`/c/${companySlug}/invoices/${invoiceId}/void`, parsed.data, invoiceWireSchema, {
      token,
    });
  } catch (err) {
    return mapApiError(err, 'ยกเลิกใบแจ้งหนี้ไม่สำเร็จ');
  }

  revalidatePath(`/c/${companySlug}/invoices/${invoiceId}`);
  revalidatePath(`/c/${companySlug}/invoices`);
  return { ok: true };
}

// =========================================================================
// Batch generation
// =========================================================================

export type BatchGenerateResult =
  | {
      ok: false;
      code: 'VALIDATION' | 'CONFLICT' | 'FORBIDDEN' | 'NETWORK' | 'UNKNOWN';
      message: string;
    }
  | { ok: true; result: BatchGenerateInvoicesResultWire };

/**
 * Generate draft invoices for every active contract in a period.
 *
 * Idempotency: the API enforces uniqueness on (contractId, period) so a
 * duplicate call surfaces as `duplicate_invoice` skip entries — safe to
 * re-run. We also send an `Idempotency-Key` header per CLAUDE.md §3 #10
 * (random UUID per request — the FRONTEND identifies "this submit" while
 * the API's per-row uniqueness handles "this contract+period").
 */
export async function batchGenerateInvoicesAction(
  companySlug: string,
  input: BatchGenerateInvoicesInput,
): Promise<BatchGenerateResult> {
  const parsed = batchGenerateInvoicesInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'รูปแบบข้อมูลไม่ถูกต้อง — ตรวจสอบรอบบิลและวันครบกำหนด',
    };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) {
    return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };
  }

  let result: BatchGenerateInvoicesResultWire;
  try {
    result = await api.post(
      `/c/${companySlug}/invoices/batch`,
      parsed.data,
      batchGenerateInvoicesResultWireSchema,
      { token, idempotencyKey: randomUUID() },
    );
  } catch (err) {
    const mapped = mapApiError(err, 'สร้างใบแจ้งหนี้ไม่สำเร็จ');
    if (mapped.ok === false && mapped.code === 'NOT_FOUND') {
      // /batch endpoint shouldn't 404 — fall through to generic handler.
      return { ok: false, code: 'UNKNOWN', message: mapped.message };
    }
    return mapped as BatchGenerateResult;
  }

  // Refresh the list so the new drafts show up when the manager navigates back.
  revalidatePath(`/c/${companySlug}/invoices`);
  return { ok: true, result };
}

/** Translate an ApiError into the shared discriminated-union shape. */
function mapApiError(err: unknown, fallbackMessage: string): InvoiceActionResult {
  if (err instanceof ApiError) {
    if (err.statusCode === 404 || err.code === 'NotFoundException') {
      return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบใบแจ้งหนี้นี้' };
    }
    if (err.statusCode === 409 || err.code === 'ConflictException') {
      return {
        ok: false,
        code: 'CONFLICT',
        message: 'สถานะใบแจ้งหนี้ปัจจุบันไม่อนุญาตการดำเนินการนี้',
      };
    }
    if (err.statusCode === 403 || err.code === 'ForbiddenException') {
      return { ok: false, code: 'FORBIDDEN', message: 'คุณไม่มีสิทธิ์ดำเนินการนี้' };
    }
    if (err.code === 'NetworkError') {
      return { ok: false, code: 'NETWORK', message: 'การเชื่อมต่อมีปัญหา กรุณาลองใหม่' };
    }
  }
  console.error('[invoices/action] unexpected error:', err);
  return { ok: false, code: 'UNKNOWN', message: fallbackMessage };
}
