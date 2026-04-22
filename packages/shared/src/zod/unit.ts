import { z } from 'zod';
import { companyIdSchema, moneySchema, uuidSchema } from './primitives.js';

/**
 * Unit (room) status — mirrors Prisma enum `unit_status`. `vacant` = no
 * contract active right now; `reserved` = holding for a new tenant (deposit
 * paid but contract not yet started); `maintenance` = un-rentable temporarily.
 */
export const unitStatusSchema = z.enum(['vacant', 'occupied', 'maintenance', 'reserved']);
export type UnitStatus = z.infer<typeof unitStatusSchema>;

export const unitSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  propertyId: uuidSchema,
  // VarChar(32) in DB — operators sometimes encode floor+number (e.g. "A-305").
  unitNumber: z.string().min(1).max(32),
  floor: z.number().int().min(0).max(200),
  // Optional size (m²) — some operators don't track this.
  sizeSqm: moneySchema.nullable(),
  baseRent: moneySchema,
  status: unitStatusSchema.default('vacant'),
  notes: z.string().max(512).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Unit = z.infer<typeof unitSchema>;

export const createUnitInputSchema = z.object({
  propertyId: uuidSchema,
  unitNumber: z.string().min(1).max(32),
  floor: z.number().int().min(0).max(200).default(1),
  sizeSqm: moneySchema.optional(),
  baseRent: moneySchema,
  notes: z.string().max(512).optional(),
});
export type CreateUnitInput = z.infer<typeof createUnitInputSchema>;

export const updateUnitInputSchema = createUnitInputSchema
  .partial()
  .extend({ status: unitStatusSchema.optional() });
export type UpdateUnitInput = z.infer<typeof updateUnitInputSchema>;

/**
 * Query for `GET /c/:slug/units`. Filters AND-combined.
 *
 * `propertyId` filter is the most common access pattern (admin browses a
 * single building); `status` filter powers the "show me vacancies" view.
 *
 * `cursor` is opaque base64url JSON `(createdAt, id)` decoded server-side.
 * `limit` uses `z.coerce.number()` because query strings arrive as strings.
 */
export const listUnitsQuerySchema = z.object({
  propertyId: uuidSchema.optional(),
  status: unitStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListUnitsQuery = z.infer<typeof listUnitsQuerySchema>;
