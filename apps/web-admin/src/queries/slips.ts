import { type Slip, slipSchema, slipViewUrlResponseSchema } from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schemas for the Slip API.
 *
 * `uploadedAt` and `expiresAt` come over the wire as ISO strings — coerce
 * to Date for ergonomics. Slip metadata is fetched only when an operator
 * expands a row to review (lazy via Server Action).
 */

export const slipWireSchema = slipSchema.extend({
  uploadedAt: z.coerce.date(),
});
export type SlipWire = z.infer<typeof slipWireSchema>;

export const slipViewUrlWireSchema = slipViewUrlResponseSchema.extend({
  expiresAt: z.coerce.date(),
});
export type SlipViewUrlWire = z.infer<typeof slipViewUrlWireSchema>;

export type { Slip };
