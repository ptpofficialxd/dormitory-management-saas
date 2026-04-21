import { z } from 'zod';
import { companyIdSchema, cursorSchema, isoUtcSchema, uuidSchema } from './primitives.js';

/**
 * Append-only audit trail (CLAUDE.md §3.7). The DB denies UPDATE/DELETE via
 * trigger, so clients may only INSERT and SELECT. Rows are RLS-scoped by
 * `companyId` — `app.company_id` MUST be set before INSERT or the tenant
 * policy will default-deny.
 *
 * `action` is free-form (e.g. `POST /c/acme/payments`) because the admin
 * surface grows faster than we'd maintain an enum. `resource` is the first
 * meaningful path segment (`payment`, `invoice`, …) — also free-form to
 * preserve flexibility. Keep both ≤ 64 chars to match Prisma VarChar(64).
 *
 * `metadata` is a JSONB object — services are free to stash redacted
 * request/response hints (`{ amount: "5500.00", invoiceId: "…" }`). NEVER
 * put raw PII (nationalId, bank account, password) in here — the audit log
 * itself is readable by every company_owner, so stash only references + IDs.
 */

/** Shape of a row returned by `GET /audit-logs` (already Prisma-backed). */
export const auditLogSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  actorUserId: uuidSchema.nullable(),
  action: z.string().min(1).max(64),
  resource: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(64).nullable(),
  /** Free-form structured context — NEVER contains raw PII. */
  metadata: z.record(z.unknown()),
  /** `Inet` column — accept either IPv4 or IPv6 textual form. Nullable. */
  ipAddress: z.string().ip().nullable(),
  userAgent: z.string().min(1).max(512).nullable(),
  createdAt: isoUtcSchema,
});
export type AuditLog = z.infer<typeof auditLogSchema>;

/**
 * Input for the service layer when a handler wants to emit an extra audit
 * row in addition to the automatic one from `AuditLogInterceptor` (e.g. a
 * payment confirm emits `action: payment.confirm`, not just `POST /…`).
 *
 * `companyId` is NOT in this schema — it's pulled from the tenant context
 * (`app.company_id`) so services cannot accidentally cross tenants.
 */
export const writeAuditLogInputSchema = z.object({
  action: z.string().min(1).max(64),
  resource: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(64).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type WriteAuditLogInput = z.infer<typeof writeAuditLogInputSchema>;

/**
 * Query params for `GET /c/:slug/audit-logs`. Cursor-paginated; all filters
 * AND together. Dates are inclusive-exclusive half-open intervals
 * (`[fromDate, toDate)`) — matches the `created_at DESC` index layout.
 */
export const listAuditLogsInputSchema = z.object({
  actorUserId: uuidSchema.optional(),
  resource: z.string().min(1).max(64).optional(),
  action: z.string().min(1).max(64).optional(),
  /** Inclusive start — UTC ISO 8601 (`Z` suffix). */
  fromDate: isoUtcSchema.optional(),
  /** Exclusive end — UTC ISO 8601. */
  toDate: isoUtcSchema.optional(),
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type ListAuditLogsInput = z.infer<typeof listAuditLogsInputSchema>;
