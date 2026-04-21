import { z } from 'zod';
import { companyIdSchema, slugSchema, uuidSchema } from './primitives.js';

export const propertySchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  slug: slugSchema,
  name: z.string().min(1).max(120),
  address: z.string().min(1).max(500),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Property = z.infer<typeof propertySchema>;

export const createPropertyInputSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120),
  address: z.string().min(1).max(500),
});
export type CreatePropertyInput = z.infer<typeof createPropertyInputSchema>;

export const updatePropertyInputSchema = createPropertyInputSchema.partial();
export type UpdatePropertyInput = z.infer<typeof updatePropertyInputSchema>;
