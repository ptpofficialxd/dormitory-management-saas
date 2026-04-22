import { z } from 'zod';
import { companyIdSchema, isoUtcSchema, uuidSchema } from './primitives.js';

/**
 * Allowed slip MIME types. Whitelisted explicitly because CLAUDE.md §7
 * says "never trust client MIME; re-check magic bytes" — the server verifies
 * the actual bytes against this list before storing.
 */
export const slipMimeTypeSchema = z.enum([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);
export type SlipMimeType = z.infer<typeof slipMimeTypeSchema>;

/** Max slip size — 10 MB. LIFF client must compress before upload. */
export const SLIP_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Payment proof (slip) image. Exactly one per Payment (`@unique paymentId`).
 * Stored in R2 private bucket. `sha256` is indexed — duplicate hashes flag
 * "reused slip" fraud (same receipt submitted for two invoices).
 */
export const slipSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  paymentId: uuidSchema,
  /** R2 object key (private bucket) — never exposed directly to clients. */
  r2ObjectKey: z.string().min(1).max(512),
  mimeType: slipMimeTypeSchema,
  sizeBytes: z.number().int().min(1).max(SLIP_MAX_SIZE_BYTES),
  /** Hex-encoded SHA-256 — always 64 lowercase hex chars. */
  sha256: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]{64}$/, 'Expected lowercase hex SHA-256'),
  uploadedAt: isoUtcSchema,
});
export type Slip = z.infer<typeof slipSchema>;

/**
 * Input for `POST /c/:slug/payments/:paymentId/slip/upload-url` —
 * the LIFF client tells the server "I'm about to upload a slip of THIS
 * mime + THIS size", and the server replies with a presigned PUT URL +
 * a deterministic `r2ObjectKey` it MUST echo back when registering.
 *
 * `sizeBytes` is signed into the presigned URL (Content-Length) so the
 * client cannot tamper with the upload size after URL minting — see
 * StorageService.generateUploadUrl.
 */
export const slipUploadUrlInputSchema = z.object({
  mimeType: slipMimeTypeSchema,
  sizeBytes: z.number().int().min(1).max(SLIP_MAX_SIZE_BYTES),
});
export type SlipUploadUrlInput = z.infer<typeof slipUploadUrlInputSchema>;

/**
 * Response for `POST .../slip/upload-url`. The client PUTs raw bytes to
 * `url` with `Content-Type: <mimeType>` + `Content-Length: <sizeBytes>`,
 * then echoes `r2ObjectKey` back to the register endpoint so the server
 * can `HEAD` it without trusting client-supplied paths.
 */
export const slipUploadUrlResponseSchema = z.object({
  url: z.string().url(),
  r2ObjectKey: z.string().min(1).max(512),
  expiresAt: isoUtcSchema,
});
export type SlipUploadUrlResponse = z.infer<typeof slipUploadUrlResponseSchema>;

/**
 * Input for `POST /c/:slug/payments/:paymentId/slip` (register). Called
 * AFTER the client has uploaded raw bytes to the presigned URL.
 *
 * Security model:
 *   - `r2ObjectKey` is echoed back from the upload-url response. The
 *     server re-validates that the prefix matches
 *     `companies/{companyId}/slips/{paymentId}/` before HEADing R2 —
 *     a tampered key targeting another tenant's namespace gets a 400.
 *   - `mimeType` + `sizeBytes` MUST match what R2 reports via HEAD.
 *     `sizeBytes` is also signed into the presigned URL so a too-large
 *     upload gets rejected by R2 at PUT time, not by us.
 *   - `sha256` is computed by the client over the raw bytes and stored
 *     for dedupe / fraud detection (same slip uploaded for two invoices).
 *     Verifying the hash server-side would require streaming the object
 *     back from R2 — deferred to Phase 1 fraud-review.
 */
export const uploadSlipInputSchema = z.object({
  r2ObjectKey: z.string().min(1).max(512),
  mimeType: slipMimeTypeSchema,
  sizeBytes: z.number().int().min(1).max(SLIP_MAX_SIZE_BYTES),
  sha256: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]{64}$/, 'Expected lowercase hex SHA-256'),
});
export type UploadSlipInput = z.infer<typeof uploadSlipInputSchema>;

/**
 * Response for `GET /c/:slug/slips/:id/view-url` — short-lived signed
 * GET URL the admin dashboard / LIFF tenant uses to preview the slip
 * image. TTL is bounded by `R2_SIGNED_URL_TTL` (5 min default).
 */
export const slipViewUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: isoUtcSchema,
});
export type SlipViewUrlResponse = z.infer<typeof slipViewUrlResponseSchema>;
