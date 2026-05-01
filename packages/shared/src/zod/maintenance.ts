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
 *
 * Date fields use `z.date()` (NOT `isoUtcSchema`) to match the rest of the
 * domain models (Invoice / Contract / Payment / Tenant) — Prisma returns
 * `Date` objects, and consumer apps (web-admin / liff-tenant) re-derive
 * with `z.coerce.date()` at the wire boundary so JSON ISO strings parse
 * cleanly. Using `isoUtcSchema` here would mismatch Prisma's runtime type
 * + break `buildCursorPage<T>` which keys off `T['createdAt']`.
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
  resolvedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
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
 *
 * `tenantId` filter on the admin path so the slip-review-style "show me a
 * specific tenant's tickets" workflow works without a separate endpoint.
 * On the LIFF path the controller IGNORES caller-supplied tenantId and
 * forces it from the JWT — the schema permits the field for symmetry.
 */
export const listMaintenanceRequestsInputSchema = z.object({
  status: maintenanceStatusSchema.optional(),
  priority: maintenancePrioritySchema.optional(),
  category: maintenanceCategorySchema.optional(),
  unitId: uuidSchema.optional(),
  tenantId: uuidSchema.optional(),
  assignedToUserId: uuidSchema.optional(),
  /** Inclusive start — filter on `created_at`. */
  fromDate: isoUtcSchema.optional(),
  /** Exclusive end — filter on `created_at`. */
  toDate: isoUtcSchema.optional(),
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListMaintenanceRequestsInput = z.infer<typeof listMaintenanceRequestsInputSchema>;

// ---------------------------------------------------------------------------
// Photo upload + view URL contracts (Sprint B / Task #88)
//
// Mirrors the Slip flow (upload-url → PUT to R2 → register) but adapted to
// the maintenance-ticket lifecycle: photos are uploaded BEFORE the ticket
// row exists (LIFF UX is "describe → photo → submit"), so the R2 key is
// scoped by `tenantId` (the only known entity at upload time), NOT by
// ticketId. At create time, the tenant submits an array of `photoR2Keys`
// the server has previously minted for them.
// ---------------------------------------------------------------------------

/**
 * Allowed maintenance photo MIME types. Subset of slip's allowlist —
 * tickets are visual-only (no PDF receipts), so we narrow to image kinds.
 */
export const maintenancePhotoMimeTypeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp']);
export type MaintenancePhotoMimeType = z.infer<typeof maintenancePhotoMimeTypeSchema>;

/** Max photo size — 10 MB. LIFF must compress before upload (matches slip). */
export const MAINTENANCE_PHOTO_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Input for `POST /me/maintenance/photos/upload-url` — tenant tells server
 * "I'm about to upload a maintenance photo of THIS mime + THIS size", and
 * server replies with a presigned PUT URL + a deterministic `r2ObjectKey`.
 *
 * The tenant collects multiple keys (one per photo) and submits the array
 * with the create-ticket POST. There is no separate "register photo" call
 * — the server validates each key's R2 HEAD inside `createForTenant`.
 */
export const maintenancePhotoUploadUrlInputSchema = z.object({
  mimeType: maintenancePhotoMimeTypeSchema,
  sizeBytes: z.number().int().min(1).max(MAINTENANCE_PHOTO_MAX_SIZE_BYTES),
});
export type MaintenancePhotoUploadUrlInput = z.infer<typeof maintenancePhotoUploadUrlInputSchema>;

/** Response for `POST /me/maintenance/photos/upload-url`. */
export const maintenancePhotoUploadUrlResponseSchema = z.object({
  url: z.string().url(),
  r2ObjectKey: z.string().min(1).max(512),
  expiresAt: isoUtcSchema,
});
export type MaintenancePhotoUploadUrlResponse = z.infer<
  typeof maintenancePhotoUploadUrlResponseSchema
>;

/**
 * Response for `GET /c/:slug/maintenance/:id/photos/:key/view-url` — admin
 * preview of a tenant-uploaded photo. TTL ≤ 5 min per CLAUDE.md §3.9.
 */
export const maintenancePhotoViewUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: isoUtcSchema,
});
export type MaintenancePhotoViewUrlResponse = z.infer<typeof maintenancePhotoViewUrlResponseSchema>;

// ---------------------------------------------------------------------------
// Tenant self-update (Sprint B / Task #100)
//
// Distinct from `updateMaintenanceRequestInputSchema` (admin) — tenant can:
//   - cancel their own ticket (only when status=open)
//   - extend `description` (when status in [open, in_progress])
//   - APPEND photos (when status in [open, in_progress]) — never replace,
//     never remove (preserves audit trail of original report)
//
// Tenant CANNOT:
//   - change title / category / priority (those define the ticket identity;
//     if wrong, cancel + re-create)
//   - assign / change status to anything other than `cancelled`
//   - edit `resolutionNote` (that's staff-authored)
//
// Service-layer enforces:
//   - state machine: cancel only allowed when status=open (other transitions
//     throw 409); description / photo append only when status in
//     [open, in_progress]
//   - photo prefix re-validation (every appended key must start with
//     `companies/{companyId}/maintenance/{tenantId}/`) + R2 HEAD
//   - combined cap: existing.photoR2Keys.length + appendPhotoR2Keys.length
//     ≤ MAINTENANCE_PHOTO_MAX
// ---------------------------------------------------------------------------

export const tenantUpdateMaintenanceRequestInputSchema = z
  .object({
    /** Updated free-form description (replaces, not appends). */
    description: z.string().min(1).max(2048).optional(),
    /** R2 keys to APPEND to `photoR2Keys`. Each must pass the same prefix +
     *  HEAD validation as on create. */
    appendPhotoR2Keys: z.array(r2ObjectKeySchema).max(MAINTENANCE_PHOTO_MAX).optional(),
    /** Tenant-initiated cancel — service rejects if status !== 'open'. */
    cancel: z.literal(true).optional(),
  })
  .refine(
    (v) =>
      v.description !== undefined ||
      (v.appendPhotoR2Keys !== undefined && v.appendPhotoR2Keys.length > 0) ||
      v.cancel === true,
    'At least one of description / appendPhotoR2Keys / cancel must be provided',
  );
export type TenantUpdateMaintenanceRequestInput = z.infer<
  typeof tenantUpdateMaintenanceRequestInputSchema
>;
