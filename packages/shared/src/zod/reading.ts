import { z } from 'zod';
import {
  companyIdSchema,
  isoUtcSchema,
  meterValueSchema,
  periodSchema,
  uuidSchema,
} from './primitives.js';

/**
 * Monthly meter reading. `consumption = valueCurrent - valuePrevious` is
 * derived but STORED for audit: if a past reading is corrected, we don't
 * want the invoice total to silently drift.
 *
 * `photoKey` is the R2 object key (private bucket). The API returns a
 * signed URL (≤5min TTL per CLAUDE.md §3.9) — never the raw key to clients.
 */
export const readingSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  meterId: uuidSchema,
  period: periodSchema,
  valueCurrent: meterValueSchema,
  valuePrevious: meterValueSchema,
  consumption: meterValueSchema,
  photoKey: z.string().max(512).nullable(),
  readAt: isoUtcSchema,
  readByUserId: uuidSchema.nullable(),
  createdAt: z.date(),
});
export type Reading = z.infer<typeof readingSchema>;

/**
 * Input for `POST /readings`. Service computes `consumption` =
 * `money.sub(valueCurrent, valuePrevious)` and enforces ≥ 0.
 * `valuePrevious` is looked up server-side from the prior period's reading
 * — client just submits what the meter shows today.
 */
export const createReadingInputSchema = z.object({
  meterId: uuidSchema,
  period: periodSchema,
  valueCurrent: meterValueSchema,
  photoKey: z.string().max(512).optional(),
  readAt: isoUtcSchema.optional(),
});
export type CreateReadingInput = z.infer<typeof createReadingInputSchema>;

/** Input for `PATCH /readings/:id` — rare, usually correcting a typo. */
export const updateReadingInputSchema = z.object({
  valueCurrent: meterValueSchema.optional(),
  photoKey: z.string().max(512).optional(),
  readAt: isoUtcSchema.optional(),
});
export type UpdateReadingInput = z.infer<typeof updateReadingInputSchema>;

/**
 * Query string for `GET /readings`. Filter by `meterId`/`period` combine
 * under AND; cursor + limit follow the standard pattern. `period` filter
 * is exact-match (`YYYY-MM`) — Phase 2 will add range filtering.
 */
export const listReadingsQuerySchema = z.object({
  meterId: uuidSchema.optional(),
  period: periodSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListReadingsQuery = z.infer<typeof listReadingsQuerySchema>;
