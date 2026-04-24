import {
  type PaymentMethod,
  type PaymentStatus,
  type SlipMimeType,
  paymentMethodSchema,
  paymentStatusSchema,
  slipMimeTypeSchema,
} from '@dorm/shared/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { type ApiError, apiGet, apiPost } from '../lib/api.js';

/**
 * WIRE schemas for /me/payments — JSON over the wire delivers Date as ISO
 * string. `paidAt` and `confirmedAt` are nullable on the schema; coerce
 * only when present.
 */

export const paymentWireSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  tenantId: z.string().uuid(),
  amount: z.string(),
  method: paymentMethodSchema,
  status: paymentStatusSchema,
  paidAt: z.coerce.date().nullable(),
  confirmedAt: z.coerce.date().nullable(),
  confirmedByUserId: z.string().uuid().nullable(),
  rejectionReason: z.string().nullable(),
  idempotencyKey: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PaymentWire = z.infer<typeof paymentWireSchema>;

export const paymentPageWireSchema = z.object({
  items: z.array(paymentWireSchema),
  nextCursor: z.string().nullable(),
});
export type PaymentPageWire = z.infer<typeof paymentPageWireSchema>;

// -------------------------------------------------------------------------
// Slip wire schemas
// -------------------------------------------------------------------------

export const slipWireSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  paymentId: z.string().uuid(),
  r2ObjectKey: z.string(),
  mimeType: slipMimeTypeSchema,
  sizeBytes: z.number().int(),
  sha256: z.string().length(64),
  uploadedAt: z.coerce.date(),
});
export type SlipWire = z.infer<typeof slipWireSchema>;

export const slipUploadUrlResponseWireSchema = z.object({
  url: z.string().url(),
  r2ObjectKey: z.string(),
  expiresAt: z.coerce.date(),
});
export type SlipUploadUrlResponseWire = z.infer<typeof slipUploadUrlResponseWireSchema>;

export type { PaymentMethod, PaymentStatus, SlipMimeType };

// -------------------------------------------------------------------------
// Hooks
// -------------------------------------------------------------------------

/**
 * useInvoicePayments — `GET /me/payments?invoiceId=:id` filtered to one
 * invoice. Used by the invoice detail page to render payment history (one
 * row per attempted slip / cash record).
 *
 * Bypasses the cursor for MVP — payments per invoice are O(1-3); the API's
 * default page size of 20 is more than enough.
 */
export function useInvoicePayments(opts: { token: string; invoiceId: string }) {
  return useQuery<PaymentPageWire, ApiError>({
    queryKey: ['me', 'payments', 'by-invoice', opts.invoiceId],
    queryFn: () =>
      apiGet(
        `/me/payments?invoiceId=${encodeURIComponent(opts.invoiceId)}`,
        paymentPageWireSchema,
        {
          token: opts.token,
        },
      ),
    enabled: Boolean(opts.token) && Boolean(opts.invoiceId),
    // Tenant just submitted a slip → wants to see the new pending row.
    // Short stale-time keeps "ดูรายละเอียด" responsive after upload.
    staleTime: 5_000,
    retry: (failureCount, error) => {
      if ((error as ApiError).statusCode === 401) return false;
      return failureCount < 2;
    },
  });
}

// -------------------------------------------------------------------------
// Slip upload — orchestrated 4-step flow
// -------------------------------------------------------------------------

export interface SlipUploadInput {
  invoiceId: string;
  amount: string;
  method: PaymentMethod;
  file: File;
}

export interface SlipUploadResult {
  payment: PaymentWire;
  slip: SlipWire;
}

/**
 * useSlipUpload — orchestrates the full slip submit flow.
 *
 * Steps (any failure rolls forward only — the API's idempotency key keeps
 * a half-finished retry safe):
 *
 *   1. Compute SHA-256 of the file via SubtleCrypto. Done locally so we
 *      never trust a client-supplied digest server-side (the API also
 *      verifies via R2 HEAD post-upload).
 *   2. POST /me/payments  with a fresh idempotency key → Payment row in
 *      `pending` status. Re-running this step with the same key returns
 *      the existing row (CLAUDE.md §3 #10).
 *   3. POST /me/payments/:id/slip/upload-url → presigned PUT URL
 *      bound to (mimeType, sizeBytes). Server signs the headers so the
 *      client can't tamper with content-length.
 *   4. PUT raw bytes directly to R2 (browser → R2; no API hop).
 *   5. POST /me/payments/:id/slip → registers the Slip row. Server HEADs
 *      R2 + verifies sha256 + size before insert.
 *
 * Returns { payment, slip } on success — caller navigates to the status
 * page (Task #74).
 */
export function useSlipUpload(opts: { token: string }) {
  return useMutation<SlipUploadResult, ApiError | Error, SlipUploadInput>({
    mutationKey: ['me', 'slip', 'upload'],
    mutationFn: async ({ invoiceId, amount, method, file }) => {
      // 1. SHA-256
      const sha256 = await computeSha256Hex(file);

      // 2. Create payment (idempotency-key required by API)
      const idempotencyKey = generateIdempotencyKey();
      const payment = await apiPost(
        '/me/payments',
        { invoiceId, amount, method, paidAt: new Date().toISOString() },
        paymentWireSchema,
        { token: opts.token, idempotencyKey },
      );

      // 3. Mint presigned PUT URL
      const upload = await apiPost(
        `/me/payments/${payment.id}/slip/upload-url`,
        { mimeType: file.type, sizeBytes: file.size },
        slipUploadUrlResponseWireSchema,
        { token: opts.token },
      );

      // 4. Direct PUT to R2 (no API hop). content-type + content-length
      // MUST match the headers signed into the URL or R2 returns 403.
      const putRes = await fetch(upload.url, {
        method: 'PUT',
        headers: {
          'content-type': file.type,
          'content-length': String(file.size),
        },
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`R2 upload failed (status ${putRes.status})`);
      }

      // 5. Register slip — server HEADs R2 + verifies sha256 / size
      const slip = await apiPost(
        `/me/payments/${payment.id}/slip`,
        {
          r2ObjectKey: upload.r2ObjectKey,
          mimeType: file.type,
          sizeBytes: file.size,
          sha256,
        },
        slipWireSchema,
        { token: opts.token },
      );

      return { payment, slip };
    },
    // No retry — the user re-submits manually. A silent retry could create
    // a second pending payment if the network blip happens between the
    // /payments POST and the /slip POST (the idempotency-key handles the
    // payment row, but a second slip POST would 409 confusingly).
    retry: false,
  });
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/** Compute the SHA-256 of a File and return its lowercase hex digest. */
async function computeSha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate an idempotency key (8–128 chars per API) for POST /me/payments.
 * Uses crypto.randomUUID() — 36-char string, well within bounds, RFC 4122 v4.
 */
function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}
