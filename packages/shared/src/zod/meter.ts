import { z } from 'zod';
import { companyIdSchema, rateSchema, uuidSchema } from './primitives.js';

/** Meter kind — mirrors Prisma enum `meter_kind`. One per kind per unit. */
export const meterKindSchema = z.enum(['water', 'electric']);
export type MeterKind = z.infer<typeof meterKindSchema>;

/**
 * Unit-of-measure label printed on invoices. Free-form string (VarChar(16))
 * because operators sometimes write "หน่วย" instead of "kWh".
 */
export const unitOfMeasureSchema = z.string().min(1).max(16);

/**
 * Meter per unit (water + electric). `ratePerUnit` uses Decimal(10,4) so
 * Thai electric tariffs like `5.8124 THB/kWh` aren't rounded on storage.
 */
export const meterSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  unitId: uuidSchema,
  kind: meterKindSchema,
  serialNo: z.string().max(64).nullable(),
  unitOfMeasure: unitOfMeasureSchema,
  ratePerUnit: rateSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Meter = z.infer<typeof meterSchema>;

/** Input for `POST /meters`. */
export const createMeterInputSchema = z.object({
  unitId: uuidSchema,
  kind: meterKindSchema,
  serialNo: z.string().max(64).optional(),
  unitOfMeasure: unitOfMeasureSchema,
  ratePerUnit: rateSchema,
});
export type CreateMeterInput = z.infer<typeof createMeterInputSchema>;

/** Input for `PATCH /meters/:id` — typically only ratePerUnit changes. */
export const updateMeterInputSchema = z.object({
  serialNo: z.string().max(64).optional(),
  unitOfMeasure: unitOfMeasureSchema.optional(),
  ratePerUnit: rateSchema.optional(),
});
export type UpdateMeterInput = z.infer<typeof updateMeterInputSchema>;

/**
 * Query string for `GET /meters`. Filter by `unitId`/`kind` combine under AND;
 * cursor + limit follow the standard pattern.
 */
export const listMetersQuerySchema = z.object({
  unitId: uuidSchema.optional(),
  kind: meterKindSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListMetersQuery = z.infer<typeof listMetersQuerySchema>;
