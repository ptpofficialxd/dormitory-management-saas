import { auditLogSchema, listAuditLogsInputSchema } from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schemas for the Audit Log read endpoint (Task #119/#120).
 *
 * The shared `auditLogSchema` uses `isoUtcSchema` for `createdAt` (string
 * over the wire). We coerce it to `Date` here so the table can pass the
 * Date directly to `Intl.DateTimeFormat` without re-parsing.
 */

export const auditLogWireSchema = auditLogSchema.extend({
  createdAt: z.coerce.date(),
});
export type AuditLogWire = z.infer<typeof auditLogWireSchema>;

/** Cursor page envelope returned by `GET /c/:slug/audit-logs`. */
export const auditLogPageSchema = z.object({
  items: z.array(auditLogWireSchema),
  nextCursor: z.string().nullable(),
});
export type AuditLogPage = z.infer<typeof auditLogPageSchema>;

// Re-export the input schema so the page validates `searchParams` against
// the same shape the API enforces.
export { listAuditLogsInputSchema };
