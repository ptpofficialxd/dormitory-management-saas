import { z } from 'zod';
import { slugSchema, uuidSchema } from './primitives.js';

export const companyStatusSchema = z.enum(['active', 'suspended', 'closed']);
export type CompanyStatus = z.infer<typeof companyStatusSchema>;

/** Persistent shape — what API reads from DB. */
export const companySchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: z.string().min(1).max(120),
  status: companyStatusSchema.default('active'),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Company = z.infer<typeof companySchema>;

/** Input for `POST /companies`. */
export const createCompanyInputSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120),
});
export type CreateCompanyInput = z.infer<typeof createCompanyInputSchema>;

/** Input for `PATCH /companies/:id` — all fields optional. */
export const updateCompanyInputSchema = createCompanyInputSchema.partial();
export type UpdateCompanyInput = z.infer<typeof updateCompanyInputSchema>;
