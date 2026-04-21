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
