import {
  type ContractStatus,
  type CreateContractInput,
  type UpdateContractInput,
  contractSchema,
  contractStatusSchema,
  createContractInputSchema,
  updateContractInputSchema,
} from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schemas for the Contract API.
 *
 * Same pattern as `queries/tenants.ts` (Task #79):
 *   - shared `contractSchema` keeps `createdAt` / `updatedAt` as `z.date()`
 *     but JSON-over-wire delivers ISO strings → re-derive with `z.coerce.date()`.
 *   - `startDate` / `endDate` are `isoDateSchema` (string `YYYY-MM-DD`) so
 *     no coercion needed — they stay strings end-to-end (UI parses for
 *     display, no Date round-trip).
 *   - `rentAmount` / `depositAmount` come over the wire as strings (Decimal
 *     serialised) — `moneySchema` already handles this in shared.
 */

export const contractWireSchema = contractSchema.extend({
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
