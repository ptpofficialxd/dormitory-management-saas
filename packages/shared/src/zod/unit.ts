import { z } from 'zod';
import {
  companyIdSchema,
  moneySchema,
  uuidSchema,
} from './primitives.js';

export const unitStatusSchema = z.enum([
  'available',
  'occupied',
  'reserved',
  'maintenance',
]);
export type UnitStatus = z.infer<typeof unitStatusSchema>;

export const unitSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  propertyId: uuidSchema,
  unitNumber: z.string().min(1).max(16),
  floor: z.number().int().min(0).max(200),
  sizeSqm: moneySchema,
  baseRent: moneySchema,
  status: unitStatusSchema.default('available'),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Unit = z.infer<typeof unitSchema>;

export const createUnitInputSchema = z.object({
  propertyId: uuidSchema,
  unitNumber: z.string().min(1).max(16),
  floor: z.number().int().min(0).max(200),
  sizeSqm: moneySchema,
  baseRent: moneySchema,
});
export type CreateUnitInput = z.infer<typeof createUnitInputSchema>;

export const updateUnitInputSchema = createUnitInputSchema
  .partial()
  .extend({ status: unitStatusSchema.optional() });
export type UpdateUnitInput = z.infer<typeof updateUnitInputSchema>;
