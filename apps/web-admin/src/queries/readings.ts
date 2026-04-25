import {
  type CreateReadingInput,
  type UpdateReadingInput,
  createReadingInputSchema,
  readingSchema,
  updateReadingInputSchema,
} from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schemas for the Reading API.
 *
 * Two date-shape coercions:
 *   - `createdAt`: TIMESTAMPTZ → `z.coerce.date()` (becomes Date).
 *   - `readAt`: shared `isoUtcSchema` already enforces `YYYY-MM-DDTHH:mm:ss.sssZ`,
 *     and Prisma serialises it as the same shape — no preprocess needed
 *     (unlike contract.startDate which is `@db.Date` → ISO timestamp coerce).
 *
 * Decimal fields (`valueCurrent`, `valuePrevious`, `consumption`) stay as
 * strings (ADR-0005 — money / meter values never round-trip through JS Number).
 */

export const readingWireSchema = readingSchema.extend({
  createdAt: z.coerce.date(),
});
export type ReadingWire = z.infer<typeof readingWireSchema>;

/** Cursor page envelope returned by `GET /c/:slug/readings`. */
export const readingPageSchema = z.object({
  items: z.array(readingWireSchema),
  nextCursor: z.string().nullable(),
});
export type ReadingPage = z.infer<typeof readingPageSchema>;

// Re-export shared input schemas/types so consumers don't dual-import.
export { createReadingInputSchema, updateReadingInputSchema };
export type { CreateReadingInput, UpdateReadingInput };
