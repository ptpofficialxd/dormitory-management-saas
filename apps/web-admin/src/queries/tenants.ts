import {
  type CreateTenantInput,
  type UpdateTenantInput,
  createTenantInputSchema,
  tenantSchema,
  tenantStatusSchema,
  updateTenantInputSchema,
} from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schemas for the Tenant API.
 *
 * Same pattern as `queries/properties.ts`: shared `tenantSchema` uses
 * `z.date()` for `createdAt` / `updatedAt`, but JSON-over-wire delivers
 * ISO strings — we re-derive with `z.coerce.date()` so the typed parse
 * accepts the raw response without a manual map.
 *
 * PII fields (`phone`, `nationalId`) come back DECRYPTED from the API
 * (the service layer decrypts on read; the wire never sees ciphertext).
 * Masking happens at the UI layer (see `lib/pii.ts`) — we DON'T strip
 * them here so the detail page can reveal-on-click without a second
 * round-trip. Phase 2: route reveal through an audit-logged endpoint
 * so PII access is traceable per PDPA.
 */

export const tenantWireSchema = tenantSchema.extend({
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type TenantWire = z.infer<typeof tenantWireSchema>;

/** Cursor page envelope returned by `GET /c/:slug/tenants`. */
export const tenantPageSchema = z.object({
  items: z.array(tenantWireSchema),
  nextCursor: z.string().nullable(),
});
export type TenantPage = z.infer<typeof tenantPageSchema>;

// Re-export shared input schemas/types so consumers don't dual-import.
export { createTenantInputSchema, updateTenantInputSchema, tenantStatusSchema };
export type { CreateTenantInput, UpdateTenantInput };
export type TenantStatus = z.infer<typeof tenantStatusSchema>;
