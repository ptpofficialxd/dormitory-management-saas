import { z } from 'zod';
import { slugSchema, uuidSchema } from './primitives.js';

/**
 * Company status — mirrors Prisma enum `company_status`.
 * `churned` = former paying tenant, kept for audit/restore; use `suspended`
 * for temporary admin-side blocks (non-payment, TOS violation).
 */
export const companyStatusSchema = z.enum(['active', 'suspended', 'churned']);
export type CompanyStatus = z.infer<typeof companyStatusSchema>;

/**
 * PromptPay ID — shape-only validation (format, not reachability).
 *
 * Accepts the three EMVCo sub-tag 01/02/03 identifier formats:
 *   - 10-digit Thai mobile phone starting with `0` (sub-tag 01)
 *   - 13-digit Thai national ID                    (sub-tag 02)
 *   - 15-digit e-wallet ID                         (sub-tag 03)
 *
 * We validate digits-only here (no hyphens or spaces) so the DB stores a
 * canonical form; `normalizePromptPayId` in `packages/shared/promptpay.ts`
 * still re-parses defensively at the EMVCo boundary. Keeping both means a
 * bad seed / migration can't silently ship a broken QR.
 *
 * NOT enforced: Thai national ID Luhn-like checksum. Too many valid-format
 * IDs fail a strict checksum (old-format cards) and we'd rather let the
 * tenant scan + fail at the bank than refuse to store.
 */
export const promptPayIdSchema = z
  .string()
  .regex(
    /^(?:0\d{9}|\d{13}|\d{15})$/,
    'PromptPay ID must be a 10-digit phone (starts with 0), 13-digit national ID, or 15-digit e-wallet',
  );
export type PromptPayId = z.infer<typeof promptPayIdSchema>;

/**
 * PromptPay merchant name — EMVCo tag 59 (Merchant Name).
 *
 * Hard cap is 25 chars per EMVCo spec: banking apps truncate anything longer
 * and some reject the payload. DB column is `VarChar(64)` (future-proofing
 * for non-EMVCo display names) but THIS schema is the one the QR generator
 * consults, so 25 is the binding limit.
 *
 * Character set: printable ASCII only. Thai glyphs in tag 59 render as
 * boxes / mojibake on most banking apps (they expect UTF-8 but many parse
 * latin-1). Safer to store an English trading name.
 */
export const promptPayNameSchema = z
  .string()
  .min(1)
  .max(25)
  .regex(/^[\x20-\x7E]+$/, 'PromptPay name must be printable ASCII (EMVCo tag 59)');
export type PromptPayName = z.infer<typeof promptPayNameSchema>;

/**
 * Persistent shape — what API reads from DB. Matches `VarChar(128)` on name.
 *
 * `promptPayId` / `promptPayName` are nullable because:
 *   - Seed flow creates the company row BEFORE the owner has configured
 *     payment (they'll hit the PromptPay settings page during onboarding).
 *   - `.nullable()` here matches Prisma's `String?`; anything querying a
 *     freshly-seeded row must handle `null` (billing module blocks invoice
 *     issue with a clear error when either field is unset).
 */
export const companySchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: z.string().min(1).max(128),
  status: companyStatusSchema.default('active'),
  promptPayId: promptPayIdSchema.nullable(),
  promptPayName: promptPayNameSchema.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Company = z.infer<typeof companySchema>;

/** Input for `POST /companies`. PromptPay is configured separately post-creation. */
export const createCompanyInputSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(128),
});
export type CreateCompanyInput = z.infer<typeof createCompanyInputSchema>;

/** Input for `PATCH /companies/:id` — all fields optional. */
export const updateCompanyInputSchema = createCompanyInputSchema.partial();
export type UpdateCompanyInput = z.infer<typeof updateCompanyInputSchema>;

/**
 * Input for `PUT /companies/:id/prompt-pay` — dedicated config endpoint.
 *
 * Both fields are required together: a QR without a merchant name shows
 * "Unknown Payee" in banking apps and erodes tenant trust → high refund/
 * dispute rate. Forcing the owner to supply both in one call prevents the
 * half-configured state from ever persisting.
 *
 * To CLEAR the PromptPay config (e.g. suspend payments), hit a separate
 * `DELETE /companies/:id/prompt-pay` — we don't overload this with a
 * `null`-accepting variant because PATCH semantics get ambiguous.
 */
export const updatePromptPaySettingsInputSchema = z.object({
  promptPayId: promptPayIdSchema,
  promptPayName: promptPayNameSchema,
});
export type UpdatePromptPaySettingsInput = z.infer<typeof updatePromptPaySettingsInputSchema>;
