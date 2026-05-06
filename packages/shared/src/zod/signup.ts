import { z } from 'zod';
import { authTokensSchema } from './auth.js';
import { companyIdSchema, emailSchema, slugSchema } from './primitives.js';

/**
 * AUTH-004 self-signup wizard schemas (Task #112).
 *
 * Two endpoints share these shapes:
 *   - POST /auth/signup          — body: SignupInput, response: SignupResponse
 *   - GET  /auth/check-slug      — query: CheckSlugInput, response: CheckSlugResponse
 *
 * Both endpoints are PUBLIC (no JWT). The signup endpoint creates Company +
 * User + RoleAssignment(company_owner) in one tx and returns access/refresh
 * tokens so the client can drop the user straight into `/c/:slug/...`.
 *
 * Slug shape validation lives in `slugSchema` (2–64 chars, regex). The
 * RESERVED-word check is enforced at the service / check-slug endpoint, not
 * here — Zod is for shape only (per primitives.ts convention). Likewise,
 * uniqueness against the DB is the API's job.
 */

// -------------------------------------------------------------------------
// POST /auth/signup
// -------------------------------------------------------------------------

/**
 * Self-signup input. All five identity fields are required + the user must
 * tick the terms checkbox (literal `true` so a missing/false value rejects).
 *
 * Why each field caps where it does:
 *   - companyName: matches Company.name VarChar(128). Display only — no
 *     uniqueness check (two dorms can share a name; slug disambiguates).
 *   - slug: defers to slugSchema (2–64 lowercase alphanumeric + hyphen).
 *     Reserved-word + uniqueness checks happen at the service layer.
 *   - ownerEmail: emailSchema (RFC 5321 254-char cap). Lowercased server-side
 *     before persisting; uniqueness scoped to (companyId, email) per User
 *     model — but a brand-new signup means the company didn't exist before,
 *     so the email check effectively reduces to "this exact email + this
 *     exact slug pair", which we never block at the input layer.
 *   - ownerPassword: same min/max as login (8/128). Real strength meter is
 *     a Phase 1 thing — for MVP we trust admin to pick a non-trash password
 *     and rely on rate-limit + Argon2id to absorb the rest.
 *   - ownerDisplayName: matches User.displayName VarChar(128). Required so
 *     the signup row doesn't end up with an empty name.
 *   - acceptTerms: literal `true`. Distinct from `z.boolean()` so the form
 *     can't submit `false` and have it parse cleanly.
 */
export const signupInputSchema = z.object({
  companyName: z.string().min(1).max(128),
  slug: slugSchema,
  ownerEmail: emailSchema,
  ownerPassword: z.string().min(8).max(128),
  ownerDisplayName: z.string().min(1).max(128),
  acceptTerms: z.literal(true),
});
export type SignupInput = z.infer<typeof signupInputSchema>;

/**
 * Signup response — same envelope as login (`authTokensSchema`) plus the
 * resolved company id+slug so the client can redirect to `/c/:slug/...`
 * without decoding the JWT.
 */
export const signupResponseSchema = authTokensSchema.extend({
  companyId: companyIdSchema,
  companySlug: slugSchema,
});
export type SignupResponse = z.infer<typeof signupResponseSchema>;

// -------------------------------------------------------------------------
// GET /auth/check-slug
// -------------------------------------------------------------------------

/**
 * Reasons a slug is unavailable. `taken` is the only reason that requires a
 * DB hit; the rest can be decided from the input string alone (mirrors the
 * `SlugValidationError` union from `slug.ts` plus a `taken` case).
 */
export const slugUnavailableReasonSchema = z.enum([
  'too_short',
  'too_long',
  'invalid_chars',
  'reserved',
  'taken',
]);
export type SlugUnavailableReason = z.infer<typeof slugUnavailableReasonSchema>;

/**
 * Check-slug query. We accept ANY string up to slug max length here (not the
 * stricter `slugSchema`) so the endpoint can return a structured `reason`
 * for malformed input instead of a Zod 400. UX: as the admin types into the
 * slug field, every keystroke can hit this endpoint and get an actionable
 * error code without the form ever 400ing.
 *
 * The lower bound is 1 (not 0) so the empty string still 400s — there's
 * nothing to check.
 */
export const checkSlugInputSchema = z.object({
  slug: z.string().min(1).max(64),
});
export type CheckSlugInput = z.infer<typeof checkSlugInputSchema>;

/**
 * Discriminated union: `available: true` carries no extra info; the false
 * branch always carries a `reason` so the UI can render specific guidance.
 */
export const checkSlugResponseSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true) }),
  z.object({ available: z.literal(false), reason: slugUnavailableReasonSchema }),
]);
export type CheckSlugResponse = z.infer<typeof checkSlugResponseSchema>;
