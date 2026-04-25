import {
  type CreateMeterInput,
  type MeterKind,
  createMeterInputSchema,
  meterKindSchema,
  meterSchema,
} from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schemas for the Meter API.
 *
 * Same `z.coerce.date()` pattern as `queries/units.ts` — shared `meterSchema`
 * uses `z.date()`, JSON-over-wire delivers ISO strings.
 *
 * Decimal fields (`ratePerUnit`) stay as strings (ADR-0005).
 */

export const meterWireSchema = meterSchema.extend({
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type MeterWire = z.infer<typeof meterWireSchema>;

export const meterPageSchema = z.object({
  items: z.array(meterWireSchema),
  nextCursor: z.string().nullable(),
});
export type MeterPage = z.infer<typeof meterPageSchema>;

export { createMeterInputSchema, meterKindSchema };
export type { CreateMeterInput, MeterKind };
