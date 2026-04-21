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
 * Input for `POST /payments/:paymentId/slip`. The file itself arrives as
 * `multipart/form-data`; this schema validates the parsed metadata only.
 * `r2ObjectKey` is generated server-side AFTER magic-byte validation — NOT
 * trusted from the client.
 */
export const uploadSlipInputSchema = z.object({
  mimeType: slipMimeTypeSchema,
  sizeBytes: z.number().int().min(1).max(SLIP_MAX_SIZE_BYTES),
  sha256: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]{64}$/, 'Expected lowercase hex SHA-256'),
});
export type UploadSlipInput = z.infer<typeof uploadSlipInputSchema>;
