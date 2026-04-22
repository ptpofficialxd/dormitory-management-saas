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

/**
 * Query for `GET /c/:slug/properties`. Cursor pagination per CLAUDE.md
 * convention — opaque base64 of `(createdAt, id)` decoded server-side.
 *
 * `limit` uses `z.coerce.number()` because query strings are always strings;
 * default 20, max 100 (DoS guard).
 */
export const listPropertiesQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListPropertiesQuery = z.infer<typeof listPropertiesQuerySchema>;
