import {
  type CreatePropertyInput,
  createPropertyInputSchema,
  propertySchema,
} from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schemas for the Property API.
 *
 * The shared `propertySchema` uses `z.date()` for `createdAt` / `updatedAt`,
 * but JSON-over-wire delivers them as ISO strings. We re-derive the wire
 * variants here with `z.coerce.date()` so the typed parse on the client
 * accepts the raw response without a manual map step.
 *
 * Same pattern lives in apps/liff-tenant/src/queries/tenant-invite.ts —
 * keep the divergence local to the consuming app rather than polluting
 * @dorm/shared with client-only date coercion.
 */

export const propertyWireSchema = propertySchema.extend({
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PropertyWire = z.infer<typeof propertyWireSchema>;

/** Cursor page envelope returned by `GET /c/:slug/properties`. */
export const propertyPageSchema = z.object({
  items: z.array(propertyWireSchema),
  nextCursor: z.string().nullable(),
});
export type PropertyPage = z.infer<typeof propertyPageSchema>;

// Re-export the shared input schema/type so consumers don't have to dual-import.
export { createPropertyInputSchema };
export type { CreatePropertyInput };
