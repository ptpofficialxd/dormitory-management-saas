import { z } from 'zod';
import { companyIdSchema, cursorSchema, isoUtcSchema, uuidSchema } from './primitives.js';

/**
 * Broadcast announcement — owner/manager composes once, LINE push fan-outs
 * to the targeted audience. MVP is one-way (admin → tenants); replies
 * surface as separate inbound webhook events (see `webhook-line.ts`).
 *
 * Delivery is queued (BullMQ) because LINE Messaging API rate-limits at
 * 2 000 messages/sec per channel and we need retry on 429/5xx. The queue
 * writes back `status` + `sentAt` + `deliveredCount` when the job settles.
 *
 * Status lifecycle:
 *   draft   → scheduled      (author sets scheduledAt, saves)
 *   draft   → sending → sent | failed   (author clicks "Send now")
 *   scheduled → sending → sent | failed (worker picks it up at `scheduledAt`)
 *   any     → cancelled                 (only while draft/scheduled)
 */

/**
 * Audience scope. `all` = every active tenant in the company. `property`
 * narrows to one building; `floor` to one floor; `unit` to a list of
 * specific units; `tenant` to explicit tenant IDs (lowest-level, e.g.
 * per-recipient reminders).
 *
 * The matching scope field (`propertyId`, `floor`, `unitIds`, `tenantIds`)
 * is required by the service layer per audience — Zod enforces the shape
 * via discriminated union below.
 */
export const announcementAudienceSchema = z.enum(['all', 'property', 'floor', 'unit', 'tenant']);
export type AnnouncementAudience = z.infer<typeof announcementAudienceSchema>;

export const announcementStatusSchema = z.enum([
  'draft',
  'scheduled',
  'sending',
  'sent',
  'failed',
  'cancelled',
]);
export type AnnouncementStatus = z.infer<typeof announcementStatusSchema>;

/**
 * Discriminated by `audience`. Keeps the "which scope param is required"
 * check at parse time instead of in the service layer — so a `property`
 * announcement CANNOT be submitted without `propertyId`, etc.
 *
 * MVP constraint — max 200 explicit IDs per `unit` / `tenant` blast to
 * keep the fan-out queue payload bounded.
 */
const AUDIENCE_MAX_IDS = 200 as const;
export const ANNOUNCEMENT_AUDIENCE_MAX_IDS = AUDIENCE_MAX_IDS;

const audienceAllSchema = z.object({ audience: z.literal('all') });

const audiencePropertySchema = z.object({
  audience: z.literal('property'),
  propertyId: uuidSchema,
});

const audienceFloorSchema = z.object({
  audience: z.literal('floor'),
  propertyId: uuidSchema,
  /** 1-based floor number. `floor(0)` reserved for ground — matches `unit.floor`. */
  floor: z.number().int().min(0).max(200),
});

const audienceUnitSchema = z.object({
  audience: z.literal('unit'),
  unitIds: z.array(uuidSchema).min(1).max(AUDIENCE_MAX_IDS),
});

const audienceTenantSchema = z.object({
  audience: z.literal('tenant'),
  tenantIds: z.array(uuidSchema).min(1).max(AUDIENCE_MAX_IDS),
});

/** Discriminated audience target — exactly one shape per `audience` value. */
export const announcementTargetSchema = z.discriminatedUnion('audience', [
  audienceAllSchema,
  audiencePropertySchema,
  audienceFloorSchema,
  audienceUnitSchema,
  audienceTenantSchema,
]);
export type AnnouncementTarget = z.infer<typeof announcementTargetSchema>;

/**
 * Full persisted row. `target` is stored as JSONB alongside the scalar
 * audience + optional propertyId column for efficient filtering — the Zod
 * schema presents the discriminated-union shape to callers.
 */
export const announcementSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  title: z.string().min(1).max(128),
  /**
   * Plain-text body for LINE push. 5000 chars is LINE's per-message cap;
   * we enforce 4000 to leave headroom for templated prefixes ("[ACME Dorm] …").
   */
  body: z.string().min(1).max(4000),
  target: announcementTargetSchema,
  status: announcementStatusSchema,
  /** Null means "send immediately when status flips to `sending`". */
  scheduledAt: isoUtcSchema.nullable(),
  sentAt: isoUtcSchema.nullable(),
  /** Number of LINE push calls that returned 200 on the last delivery run. */
  deliveredCount: z.number().int().min(0),
  /** Number of LINE push calls that failed permanently (after retries). */
  failedCount: z.number().int().min(0),
  /** `User.id` — author of the announcement. */
  createdByUserId: uuidSchema,
  createdAt: isoUtcSchema,
  updatedAt: isoUtcSchema,
});
export type Announcement = z.infer<typeof announcementSchema>;

/**
 * Input for `POST /c/:slug/announcements`. `target` carries the audience
 * discriminator + its scope-specific fields. `scheduledAt` omitted or null
 * means "draft" — service decides `draft` vs `scheduled` vs `sending` based
 * on a separate `sendNow: boolean` hint OR an explicit future timestamp.
 */
export const createAnnouncementInputSchema = z.object({
  title: z.string().min(1).max(128),
  body: z.string().min(1).max(4000),
  target: announcementTargetSchema,
  /** Future UTC timestamp to schedule for; null → stays as draft. */
  scheduledAt: isoUtcSchema.nullable().optional(),
  /** If true, bypass scheduling and enqueue immediately. Mutually exclusive with `scheduledAt`. */
  sendNow: z.boolean().default(false),
});
export type CreateAnnouncementInput = z.infer<typeof createAnnouncementInputSchema>;

/**
 * Input for `PATCH /c/:slug/announcements/:id`. Only valid while status
 * is `draft` or `scheduled` — the API rejects mutations on terminal states.
 */
export const updateAnnouncementInputSchema = z
  .object({
    title: z.string().min(1).max(128).optional(),
    body: z.string().min(1).max(4000).optional(),
    target: announcementTargetSchema.optional(),
    scheduledAt: isoUtcSchema.nullable().optional(),
    /** Explicit cancel. Reaches terminal `cancelled` status. */
    cancel: z.boolean().optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    'At least one field must be provided',
  );
export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementInputSchema>;

/** Query params for `GET /c/:slug/announcements`. */
export const listAnnouncementsInputSchema = z.object({
  status: announcementStatusSchema.optional(),
  audience: announcementAudienceSchema.optional(),
  createdByUserId: uuidSchema.optional(),
  fromDate: isoUtcSchema.optional(),
  toDate: isoUtcSchema.optional(),
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type ListAnnouncementsInput = z.infer<typeof listAnnouncementsInputSchema>;
