'use server';

import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import {
  type MaintenancePhotoViewUrlResponse,
  type MaintenanceRequestWire,
  type UpdateMaintenanceRequestInput,
  maintenancePhotoViewUrlResponseSchema,
  maintenanceRequestWireSchema,
  updateMaintenanceRequestInputSchema,
} from '@/queries/maintenance';
import { revalidatePath } from 'next/cache';

/**
 * Server Actions for maintenance ticket mutations.
 *
 * MVP scope: ONLY `updateMaintenanceAction` — admin status flip / assign /
 * resolution note. There's no admin-side `create` (tickets are tenant-
 * created via LIFF) and no delete (use status=cancelled).
 *
 * Same discriminated-union return pattern as actions/tenants /
 * actions/contracts — the detail page narrows on `result.ok`.
 *
 * Error code surfacing maps NestJS exception bodies → friendly Thai
 * messages. The MaintenanceService uses these `error` codes:
 *   - InvalidStatusTransition (state machine)
 *   - ResolutionNoteRequired (resolved/cancelled need note)
 *   - InvalidAssignee (user not in this company)
 */

export type MaintenanceActionResult =
  | {
      ok: false;
      code:
        | 'VALIDATION'
        | 'INVALID_TRANSITION'
        | 'RESOLUTION_NOTE_REQUIRED'
        | 'INVALID_ASSIGNEE'
        | 'NOT_FOUND'
        | 'FORBIDDEN'
        | 'NETWORK'
        | 'UNKNOWN';
      message: string;
    }
  | { ok: true; ticket: MaintenanceRequestWire };

export async function updateMaintenanceAction(
  companySlug: string,
  ticketId: string,
  input: UpdateMaintenanceRequestInput,
): Promise<MaintenanceActionResult> {
  const parsed = updateMaintenanceRequestInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION', message: 'กรุณาตรวจสอบข้อมูลที่กรอก' };
  }

  const token = await getAccessTokenFromCookie();
  if (!token) {
    return { ok: false, code: 'FORBIDDEN', message: 'กรุณาเข้าสู่ระบบใหม่' };
  }

  let saved: MaintenanceRequestWire;
  try {
    saved = await api.patch(
      `/c/${companySlug}/maintenance/${ticketId}`,
      parsed.data,
      maintenanceRequestWireSchema,
      { token },
    );
  } catch (err) {
    return mapMaintenanceApiError(err, 'อัปเดตแจ้งซ่อมไม่สำเร็จ');
  }

  // Bust both list + detail caches so a returned-to-list view sees the
  // new status badge / assignee, and the detail page picks up the audit
  // trail on next render.
  revalidatePath(`/c/${companySlug}/maintenance`);
  revalidatePath(`/c/${companySlug}/maintenance/${ticketId}`);

  return { ok: true, ticket: saved };
}

/**
 * Server Action: mint a signed view URL for a maintenance photo.
 *
 * Why a Server Action (not a direct fetch from the Client):
 *   - JWT lives in httpOnly cookie; browser JS can't read it for an
 *     Authorization header on a direct fetch
 *   - Doing this via Server Action lets the cookie travel with the request
 *     transparently + keeps the `${API_URL}` path private
 *
 * Returns null on failure — caller renders a "load failed" placeholder.
 */
export async function getMaintenancePhotoViewUrlAction(
  companySlug: string,
  ticketId: string,
  photoKey: string,
): Promise<MaintenancePhotoViewUrlResponse | null> {
  const token = await getAccessTokenFromCookie();
  if (!token) return null;

  try {
    const encoded = encodeURIComponent(photoKey);
    const url = await api.get(
      `/c/${companySlug}/maintenance/${ticketId}/photos/${encoded}/view-url`,
      maintenancePhotoViewUrlResponseSchema,
      { token },
    );
    return url;
  } catch (err) {
    console.error('[maintenance/photo-view-url] failed:', err);
    return null;
  }
}

/**
 * Translate ApiError → typed discriminated-union shape. Branches on
 * `err.code` first (stable identifier from MaintenanceService throws),
 * falls back to status-code branches for plain HttpException throws.
 */
function mapMaintenanceApiError(err: unknown, fallbackMessage: string): MaintenanceActionResult {
  if (err instanceof ApiError) {
    if (err.code === 'InvalidStatusTransition') {
      return {
        ok: false,
        code: 'INVALID_TRANSITION',
        message: err.message || 'ไม่สามารถเปลี่ยนสถานะได้ — กรุณาตรวจสอบลำดับการทำงาน',
      };
    }
    if (err.code === 'ResolutionNoteRequired') {
      return {
        ok: false,
        code: 'RESOLUTION_NOTE_REQUIRED',
        message: 'ต้องระบุเหตุผล/คำอธิบายก่อนปิดงานหรือตีตก',
      };
    }
    if (err.code === 'InvalidAssignee') {
      return {
        ok: false,
        code: 'INVALID_ASSIGNEE',
        message: 'ผู้รับผิดชอบที่เลือกไม่ใช่สมาชิกของหอนี้',
      };
    }
    if (err.statusCode === 404 || err.code === 'NotFoundException') {
      return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการแจ้งซ่อมนี้' };
    }
    if (err.statusCode === 403 || err.code === 'ForbiddenException') {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'คุณไม่มีสิทธิ์อัปเดต — ติดต่อเจ้าของหอ',
      };
    }
    if (err.code === 'NetworkError') {
      return { ok: false, code: 'NETWORK', message: 'การเชื่อมต่อมีปัญหา กรุณาลองใหม่' };
    }
    if (err.statusCode === 400) {
      return { ok: false, code: 'VALIDATION', message: err.message || fallbackMessage };
    }
  }
  console.error('[maintenance/action] unexpected error:', err);
  return { ok: false, code: 'UNKNOWN', message: fallbackMessage };
}
