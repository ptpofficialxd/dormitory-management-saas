import { z } from 'zod';
import { companyIdSchema, slugSchema, uuidSchema } from './primitives.js';

/**
 * A building/site owned by a company. `address` is optional (`@db.VarChar(512)`)
 * — some single-property operators sign up before a mailing address is set.
 */
export const propertySchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  slug: slugSchema,
  name: z.string().min(1).max(128),
  address: z.string().max(512).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Property = z.infer<typeof propertySchema>;

export const createPropertyInputSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(128),
  address: z.string().max(512).optional(),
});
export type CreatePropertyInput = z.infer<typeof createPropertyInputSchema>;

export const updatePropertyInputSchema = createPropertyInputSchema.partial();
export type UpdatePropertyInput = z.infer<typeof updatePropertyInputSchema>;
