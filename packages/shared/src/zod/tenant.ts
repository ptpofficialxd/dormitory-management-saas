import { z } from 'zod';
import {
  companyIdSchema,
  thaiMobileSchema,
  thaiNationalIdSchema,
  uuidSchema,
} from './primitives.js';

/**
 * Tenant status — mirrors Prisma enum `tenant_status`.
 *   - `active`    : has at least one active contract OR still onboarding
 *   - `moved_out` : all contracts ended, kept for audit/history
 *   - `blocked`   : staff-blocked (fraud, repeated chargebacks, etc.)
 */
export const tenantStatusSchema = z.enum(['active', 'moved_out', 'blocked']);
export type TenantStatus = z.infer<typeof tenantStatusSchema>;

/**
 * LIFF tenant — separate table from admin `user` because the auth model
 * is LINE Login (no password). PII (nationalId, phone) is encrypted at rest
 * by the service layer before INSERT (CLAUDE.md §3.8). The Zod schema below
 * represents the DECRYPTED view — service layer decrypts on read, encrypts
 * on write. Raw ciphertext never crosses the API boundary.
 */
export const tenantSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  /** LINE `userId` from LIFF `getProfile()` — opaque up to 33 chars in practice. */
  lineUserId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(128),
  pictureUrl: z.string().url().max(512).nullable(),
  nationalId: thaiNationalIdSchema.nullable(),
  phone: thaiMobileSchema.nullable(),
  status: tenantStatusSchema.default('active'),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Tenant = z.infer<typeof tenantSchema>;

/**
 * Input for `POST /tenants` — staff creating a tenant record ahead of the
 * LIFF onboarding flow. `lineUserId` becomes known the first time the tenant
 * opens the LIFF app and completes LINE Login.
 */
export const createTenantInputSchema = z.object({
  lineUserId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(128),
  pictureUrl: z.string().url().max(512).optional(),
  nationalId: thaiNationalIdSchema.optional(),
  phone: thaiMobileSchema.optional(),
});
export type CreateTenantInput = z.infer<typeof createTenantInputSchema>;

export const updateTenantInputSchema = createTenantInputSchema
  .partial()
  .extend({ status: tenantStatusSchema.optional() });
export type UpdateTenantInput = z.infer<typeof updateTenantInputSchema>;
