import {
  type AnnouncementAudience,
  type AnnouncementStatus,
  type CreateAnnouncementInput,
  announcementAudienceSchema,
  announcementSchema,
  announcementStatusSchema,
  createAnnouncementInputSchema,
} from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schemas for the Announcement API (Task #108).
 *
 * Same `z.coerce.date()` pattern as queries/maintenance.ts and friends —
 * shared `announcementSchema` uses `z.date()` (matches Prisma row shape);
 * JSON-over-wire delivers ISO strings, so the wire variant coerces back to
 * Date on the client.
 *
 * Nullable date fields (`scheduledAt`, `sentAt`) use `z.coerce.date().nullable()`
 * — same treatment as `MaintenanceRequest.resolvedAt`.
 */

export const announcementWireSchema = announcementSchema.extend({
  scheduledAt: z.coerce.date().nullable(),
  sentAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type AnnouncementWire = z.infer<typeof announcementWireSchema>;

/** Cursor page envelope returned by `GET /c/:slug/announcements`. */
export const announcementPageSchema = z.object({
  items: z.array(announcementWireSchema),
  nextCursor: z.string().nullable(),
});
export type AnnouncementPage = z.infer<typeof announcementPageSchema>;

// Re-export shared input schemas/types so consumers don't dual-import.
export { createAnnouncementInputSchema, announcementStatusSchema, announcementAudienceSchema };
export type { CreateAnnouncementInput, AnnouncementStatus, AnnouncementAudience };
