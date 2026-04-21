/**
 * Reusable Zod primitives — build domain schemas out of these instead of
 * duplicating regex / refinement logic.
 */

import { z } from 'zod';
import { PERIOD_REGEX, ROLES, SLUG_MAX_LEN, SLUG_MIN_LEN, SLUG_REGEX } from '../constants.js';

/** RFC 4122 UUID v1–v8. Used for every primary key + tenant FK. */
export const uuidSchema = z.string().uuid();

/** Tenant company ID — same as uuid but named for readability. */
export const companyIdSchema = uuidSchema.describe('companyId');

/**
 * URL slug — lowercase alphanumeric + hyphen, 2–64 chars. Matches
 * SLUG_REGEX; reserved-slug check lives in `slug.ts` validator and is NOT
 * enforced here (Zod layer is for shape, not business rules).
 */
export const slugSchema = z
  .string()
  .min(SLUG_MIN_LEN)
  .max(SLUG_MAX_LEN)
  .regex(SLUG_REGEX, 'Invalid slug format');

/** Billing period `YYYY-MM`. */
export const periodSchema = z.string().regex(PERIOD_REGEX, 'Expected YYYY-MM format');

/**
 * Money — represented on the wire as a string (e.g. `"5500.00"`). Avoids
 * JS-float precision loss across JSON boundaries (ADR-0005).
 *
 * Accepts any string that:
 *   - has optional leading `-`
 *   - has digits followed by optional `.` + 1-2 digits
 *   - total (excluding sign/dot) ≤ 10 chars — matches Prisma `Decimal(10,2)`
 */
export const moneySchema = z
  .string()
  .regex(/^-?\d{1,8}(?:\.\d{1,2})?$/, 'Invalid money format (e.g. "5500.00")')
  .refine((s) => s !== '-0' && s !== '-0.00', 'Negative zero is not allowed');

/**
 * Rate — Decimal(10,4). Used for `meter.ratePerUnit` and `invoice_item.unitPrice`.
 * Thai electric tariffs quote 4 decimals (e.g. 5.8124 THB/kWh under PEA).
 * Max 6 integer digits + 4 decimals.
 */
export const rateSchema = z
  .string()
  .regex(/^-?\d{1,6}(?:\.\d{1,4})?$/, 'Invalid rate format (e.g. "5.8124")')
  .refine((s) => s !== '-0' && !/^-0\.0+$/.test(s), 'Negative zero is not allowed');

/**
 * Meter value — Decimal(12,2). Used for meter readings + invoice item quantities.
 * Must accommodate running meter totals (which can grow past 10 digits).
 */
export const meterValueSchema = z
  .string()
  .regex(/^-?\d{1,10}(?:\.\d{1,2})?$/, 'Invalid meter value format (e.g. "1234.56")')
  .refine((s) => s !== '-0' && s !== '-0.00', 'Negative zero is not allowed');

/** ISO 8601 UTC timestamp with `Z` suffix. */
export const isoUtcSchema = z
  .string()
  .datetime({ offset: false, message: 'Expected ISO 8601 UTC (ends with Z)' });

/**
 * ISO 8601 calendar date `YYYY-MM-DD` — no time component. Matches Prisma
 * `@db.Date`. Used for contract start/end + any date-only field.
 * Does NOT validate calendar correctness (e.g. Feb 30) — Postgres will reject.
 */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Expected ISO date (YYYY-MM-DD)');

/**
 * Thai national ID — 13 digits. Does NOT verify the checksum here; too much
 * surface for false positives at the Zod layer. Apps that persist nationalId
 * should run the checksum validator separately before storing.
 */
export const thaiNationalIdSchema = z
  .string()
  .regex(/^\d{13}$/, 'Thai national ID must be 13 digits');

/**
 * Thai mobile phone — 10 digits starting with `0`. Format: `0XXXXXXXXX`.
 */
export const thaiMobileSchema = z
  .string()
  .regex(/^0\d{9}$/, 'Thai mobile must be 10 digits starting with 0');

/** Free email — NOT lowercase-normalized here. */
export const emailSchema = z.string().email().max(254);

/**
 * RBAC role name — matches the Postgres enum. Use for JWT claim validation.
 */
export const roleSchema = z.enum(ROLES);

/**
 * Idempotency-Key header — an opaque client-chosen UUID or ULID-style
 * string. Clamped length to prevent abusive headers.
 */
export const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Idempotency-Key must be URL-safe');

/**
 * Cursor-pagination token — opaque string. Clients get it from the previous
 * response, we decode server-side.
 */
export const cursorSchema = z.string().min(1).max(512);

/** Generic ordered pagination params. */
export const paginationSchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
