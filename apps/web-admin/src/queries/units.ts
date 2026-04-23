import {
  type CreateUnitInput,
  createUnitInputSchema,
  unitSchema,
  unitStatusSchema,
} from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schemas for the Unit API.
 *
 * Same `z.coerce.date()` pattern as `queries/properties.ts` — the shared
 * `unitSchema` uses `z.date()`, but JSON-over-wire delivers ISO strings.
 *
 * Decimal fields (`baseRent`, `sizeSqm`) stay as strings (ADR-0005). The
 * UI formats them via `Intl.NumberFormat` for display.
 */

export const unitWireSchema = unitSchema.extend({
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type UnitWire = z.infer<typeof unitWireSchema>;

export const unitPageSchema = z.object({
  items: z.array(unitWireSchema),
  nextCursor: z.string().nullable(),
});
export type UnitPage = z.infer<typeof unitPageSchema>;

export { createUnitInputSchema, unitStatusSchema };
export type { CreateUnitInput };
