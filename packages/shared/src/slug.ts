/**
 * URL slug validator + normalizer.
 *
 * Slugs appear in public URLs (`/c/{companySlug}/...`) and in Prisma unique
 * constraints — they must be predictable, lowercase, and safe for every
 * path segment without escaping.
 *
 * Rules (matches SLUG_REGEX in constants.ts):
 *   - 2–64 chars
 *   - `[a-z0-9-]` only
 *   - must start and end with alphanumeric (no leading / trailing hyphen)
 *   - no consecutive hyphens are NOT forbidden here — callers can add that
 *     if they care; keeping the rule minimal reduces surprises
 */

import { SLUG_MAX_LEN, SLUG_MIN_LEN, SLUG_REGEX } from './constants.js';

/**
 * List of reserved slugs that clash with app routes. Extend as routes grow.
 * Keep ALL lowercase — comparison is done on the normalized slug.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'c',
  'console',
  'dashboard',
  'docs',
  'health',
  'help',
  'home',
  'internal',
  'liff',
  'login',
  'logout',
  'me',
  'onboarding',
  'public',
  'register',
  'root',
  'settings',
  'signin',
  'signout',
  'signup',
  'static',
  'status',
  'support',
  'system',
  'webhook',
  'webhooks',
  'www',
]);

export type SlugValidationError =
  | 'too_short'
  | 'too_long'
  | 'invalid_chars'
  | 'reserved';

export type SlugValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: SlugValidationError };

/**
 * Validate a slug without normalizing. Input must already be the exact form
 * you want to store. Use {@link normalizeSlug} if the source is user input.
 */
export function validateSlug(slug: string): SlugValidationResult {
  if (slug.length < SLUG_MIN_LEN) return { ok: false, error: 'too_short' };
  if (slug.length > SLUG_MAX_LEN) return { ok: false, error: 'too_long' };
  if (!SLUG_REGEX.test(slug)) return { ok: false, error: 'invalid_chars' };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: 'reserved' };
  return { ok: true, value: slug };
}

/** Throws on invalid input — convenience for call sites that treat invalid slugs as bugs. */
export function assertSlug(slug: string): string {
  const result = validateSlug(slug);
  if (!result.ok) {
    throw new Error(`Invalid slug (${result.error}): ${JSON.stringify(slug)}`);
  }
  return result.value;
}

/**
 * Normalize a free-form string into a slug candidate.
 *
 * Lossy by design — we care more about "obviously correct" than perfect
 * reversibility. Thai characters are NOT transliterated (returns empty-ish
 * slug) to avoid silently producing confusing URLs; prompt the user to
 * provide an English slug explicitly instead.
 *
 * Steps:
 *   1. trim + lowercase
 *   2. replace whitespace/underscore with `-`
 *   3. drop any char not in `[a-z0-9-]`
 *   4. collapse consecutive `-`
 *   5. trim leading/trailing `-`
 *   6. clamp to SLUG_MAX_LEN
 *
 * The result may still fail {@link validateSlug} (e.g. too short) — always
 * re-validate before persisting.
 */
export function normalizeSlug(raw: string): string {
  return raw
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LEN);
}

/** Expose the reserved set for UI messaging / tests. Read-only copy. */
export function getReservedSlugs(): readonly string[] {
  return [...RESERVED_SLUGS].sort();
}
