import {
  type CreateMaintenanceRequestInput,
  type MaintenanceCategory,
  type MaintenancePhotoViewUrlResponse,
  type MaintenancePriority,
  type MaintenanceStatus,
  type UpdateMaintenanceRequestInput,
  createMaintenanceRequestInputSchema,
  maintenanceCategorySchema,
  maintenancePhotoViewUrlResponseSchema,
  maintenancePrioritySchema,
  maintenanceRequestSchema,
  maintenanceStatusSchema,
  updateMaintenanceRequestInputSchema,
} from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schemas for the Maintenance API (Task #89).
 *
 * Same `z.coerce.date()` pattern as the rest of the queries — shared
 * `maintenanceRequestSchema` uses `z.date()` (matches Prisma); JSON-over-
 * wire delivers ISO strings.
 *
 * Note: `resolvedAt` is nullable + Date — wire schema must coerce ONLY
 * when the value is non-null. `z.coerce.date().nullable()` does the right
 * thing because `z.coerce.date()` accepts `null` as-is when chained with
 * `.nullable()`.
 */

export const maintenanceRequestWireSchema = maintenanceRequestSchema.extend({
  resolvedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type MaintenanceRequestWire = z.infer<typeof maintenanceRequestWireSchema>;

/** Cursor page envelope returned by `GET /c/:slug/maintenance`. */
export const maintenanceRequestPageSchema = z.object({
  items: z.array(maintenanceRequestWireSchema),
  nextCursor: z.string().nullable(),
});
export type MaintenanceRequestPage = z.infer<typeof maintenanceRequestPageSchema>;

export const maintenancePhotoViewUrlWireSchema = maintenancePhotoViewUrlResponseSchema;

// Re-export shared input schemas/types so consumers don't dual-import.
export {
  createMaintenanceRequestInputSchema,
  maintenanceCategorySchema,
  maintenancePhotoViewUrlResponseSchema,
  maintenancePrioritySchema,
  maintenanceStatusSchema,
  updateMaintenanceRequestInputSchema,
};
export type {
  CreateMaintenanceRequestInput,
  MaintenanceCategory,
  MaintenancePhotoViewUrlResponse,
  MaintenancePriority,
  MaintenanceStatus,
  UpdateMaintenanceRequestInput,
};
