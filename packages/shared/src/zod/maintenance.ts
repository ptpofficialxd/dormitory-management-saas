import { z } from 'zod';
import { companyIdSchema, cursorSchema, isoUtcSchema, uuidSchema } from './primitives.js';

/**
 * Maintenance ticket (`maintenanceRequest`) — tenant creates via LIFF, staff
 * triages + resolves from admin web. Prisma model lands in Phase 5 migration;
 * this Zod schema is the cross-surface contract (LIFF ↔ API ↔ web-admin).
 *
 * Photos are stored in R2 — the schema holds R2 **object keys** (strings),
 * NOT signed URLs. Signed URLs are minted per-request by the API with TTL
 * ≤ 5min (CLAUDE.md §3.9 — same rule as ID-card images). Never serialize
 * a signed URL into a persisted schema.
 *
 * Status lifecycle:
 *   open → in_progress → resolved → closed
 *             ↓
 *         cancelled (terminal from any non-resolved state)
 *
 * The API enforces these transitions server-side; Zod only constrains the
 * value set.
 */

export const maintenanceStatusSchema = z.enum([
  'open',
  'in_progress',
  'resolved',
  'closed',
  'cancelled',
]);
export type MaintenanceStatus = z.infer<typeof maintenanceStatusSchema>;

export const maintenancePrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export type MaintenancePriority = z.infer<typeof maintenancePrioritySchema>;

/**
 * Category drives default SLA + triage routing. Keep the enum small — every
 * added category requires a downstream UI translation + SLA config. For
 * anything that doesn't fit, use `other` and rely on the free-form title.
 */
export const maintenanceCategorySchema = z.enum([
  'plumbing',
  'electrical',
  'aircon',
  'appliance',
  'furniture',
  'structural',
  'internet',
  'other',
]);
export type MaintenanceCategory = z.infer<typeof maintenanceCategorySchema>;

/** Max 10 photos per ticket — LINE rich messages cap at 10 images anyway. */
export const MAINTENANCE_PHOTO_MAX = 10 as const;

/** R2 object key — matches `slipSchema.r2ObjectKey` shape + bound. */
const r2ObjectKeySchema = z.string().min(1).max(512);

/**
 * Full ticket row — used by `GET /c/:slug/maintenance/:id` responses.
 */
export const maintenanceRequestSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  unitId: uuidSchema,
  /** Reporter — always a `Tenant` (LIFF user), never a `User` (admin/staff). */
  tenantId: uuidSchema,
  category: maintenanceCategorySchema,
  title: z.string().min(1).max(128),
  description: z.string().min(1).max(2048),
  priority: maintenancePrioritySchema,
  status: maintenanceStatusSchema,
  /** R2 object keys — signed URLs minted by API on demand. */
  photoR2Keys: z.array(r2ObjectKeySchema).max(MAINTENANCE_PHOTO_MAX),
  /** `User.id` of the staff owner; null until triaged. */
  assignedToUserId: uuidSchema.nullable(),
  /** Public-facing note from staff (shown to tenant on status update). */
  resolutionNote: z.string().max(2048).nullable(),
  resolvedAt: isoUtcSchema.nullable(),
  createdAt: isoUtcSchema,
  updatedAt: isoUtcSchema,
});
export type MaintenanceRequest = z.infer<typeof maintenanceRequestSchema>;

/**
 * Input for `POST /c/:slug/maintenance` — tenant creates a ticket. The
 * service fills in `companyId` (from tenant ctx) and `tenantId` (from
 * the authenticated LIFF session).
 *
 * `photoR2Keys` here are the object keys returned by a prior pre-signed
 * upload (same pattern as slip). Clients MUST upload to R2 first, then
 * submit this payload — so the API never buffers image bytes.
 */
export const createMaintenanceRequestInputSchema = z.object({
  unitId: uuidSchema,
  category: maintenanceCategorySchema,
  title: z.string().min(1).max(128),
  description: z.string().min(1).max(2048),
  priority: maintenancePrioritySchema.default('normal'),
  photoR2Keys: z.array(r2ObjectKeySchema).max(MAINTENANCE_PHOTO_MAX).default([]),
});
export type CreateMaintenanceRequestInput = z.infer<typeof createMaintenanceRequestInputSchema>;

/**
 * Input for `PATCH /c/:slug/maintenance/:id` — staff updates the ticket.
 * All fields optional so the same endpoint handles triage, reassignment,
 * resolution, closure.
 *
 * Cross-field invariants (service-layer, not Zod):
 *   - setting `status = resolved` → `resolvedAt` must be set
 *   - setting `status = resolved` + missing `resolutionNote` → 400
 *   - reopening (`resolved` → `in_progress`) clears `resolvedAt`
 */
export const updateMaintenanceRequestInputSchema = z
  .object({
    status: maintenanceStatusSchema.optional(),
    priority: maintenancePrioritySchema.optional(),
    assignedToUserId: uuidSchema.nullable().optional(),
    resolutionNote: z.string().max(2048).nullable().optional(),
  })
  .refine(
    (v) =>
      v.status !== undefined ||
      v.priority !== undefined ||
      v.assignedToUserId !== undefined ||
      v.resolutionNote !== undefined,
    'At least one field must be provided',
  );
export type UpdateMaintenanceRequestInput = z.infer<typeof updateMaintenanceRequestInputSchema>;

/**
 * Query params for `GET /c/:slug/maintenance`. All filters AND together;
 * cursor-paginated. `mine=true` on the LIFF surface filters by authenticated
 * tenantId — but that's enforced server-side so it's not in this schema.
 */
export const listMaintenanceRequestsInputSchema = z.object({
  status: maintenanceStatusSchema.optional(),
  priority: maintenancePrioritySchema.optional(),
  category: maintenanceCategorySchema.optional(),
  unitId: uuidSchema.optional(),
  assignedToUserId: uuidSchema.optional(),
  /** Inclusive start — filter on `created_at`. */
  fromDate: isoUtcSchema.optional(),
  /** Exclusive end — filter on `created_at`. */
  toDate: isoUtcSchema.optional(),
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type ListMaintenanceRequestsInput = z.infer<typeof listMaintenanceRequestsInputSchema>;
