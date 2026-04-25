import {
  type ContractStatus,
  type CreateContractInput,
  type UpdateContractInput,
  contractSchema,
  contractStatusSchema,
  createContractInputSchema,
  isoDateSchema,
  updateContractInputSchema,
} from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schemas for the Contract API.
 *
 * Same pattern as `queries/tenants.ts` (Task #79) plus a date-shape coercion:
 *
 *   - `createdAt` / `updatedAt`: TIMESTAMPTZ → `z.coerce.date()` (becomes Date).
 *   - `startDate` / `endDate`: `@db.Date` (Postgres DATE) — Prisma returns as
 *     a `Date` object, then `JSON.stringify` emits an ISO 8601 timestamp
 *     `"2026-04-25T00:00:00.000Z"` over the wire. The shared `isoDateSchema`
 *     enforces strict `YYYY-MM-DD` (10 chars), so we PREPROCESS to slice the
 *     first 10 chars off any incoming string before the regex check. Same
 *     output type as shared (`string YYYY-MM-DD`), no Date round-trip on
 *     the client side.
 *   - `rentAmount` / `depositAmount`: Decimal → wire string. `moneySchema`
 *     already handles this via the regex in shared.
 *
 * Phase 2 wishlist: API serialises @db.Date as YYYY-MM-DD string at the
 * controller boundary so wire schemas don't need this coercion at all. Cleaner
 * but requires an interceptor; the per-field preprocess here is fine for MVP.
 */

const isoDateWire = z.preprocess(
  (v) => (typeof v === 'string' ? v.slice(0, 10) : v),
  isoDateSchema,
);

export const contractWireSchema = contractSchema.extend({
  startDate: isoDateWire,
  endDate: isoDateWire.nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ContractWire = z.infer<typeof contractWireSchema>;

/** Cursor page envelope returned by `GET /c/:slug/contracts`. */
export const contractPageSchema = z.object({
  items: z.array(contractWireSchema),
  nextCursor: z.string().nullable(),
});
export type ContractPage = z.infer<typeof contractPageSchema>;

// Re-export shared input schemas/types so consumers don't dual-import.
export { createContractInputSchema, updateContractInputSchema, contractStatusSchema };
export type { CreateContractInput, UpdateContractInput, ContractStatus };
