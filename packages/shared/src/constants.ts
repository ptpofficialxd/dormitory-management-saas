/**
 * Locale + currency + timezone defaults for the whole app.
 *
 * CLAUDE.md §3.14 — Thailand market: `th-TH` locale, THB currency,
 * `Asia/Bangkok` display timezone (UTC+7, no DST).
 *
 * Keep this file dependency-free so it can be imported from browser (LIFF),
 * edge runtimes, and tests alike.
 */

/** BCP-47 locale for `toLocaleString`, Intl.DateTimeFormat, etc. */
export const LOCALE_TH = 'th-TH' as const;

/** ISO-4217 currency code. Used by money formatter + PromptPay. */
export const CURRENCY_THB = 'THB' as const;

/** Numeric ISO-4217 — required by EMVCo PromptPay QR payload (field 53). */
export const CURRENCY_NUMERIC_THB = '764' as const;

/** Country code — field 58 of the EMVCo PromptPay QR payload. */
export const COUNTRY_CODE_TH = 'TH' as const;

/** IANA timezone for storing UTC + displaying Bangkok wall-clock time. */
export const TIMEZONE_BANGKOK = 'Asia/Bangkok' as const;

/** Money column precision across the schema — keep in sync with Prisma `@db.Decimal(10,2)`. */
export const MONEY_PRECISION = 10 as const;
export const MONEY_SCALE = 2 as const;

/**
 * RBAC role identifiers — MUST match the Postgres enum defined in
 * `packages/db/prisma/schema.prisma`. Duplicated here (not imported) so
 * `@dorm/shared` has zero Prisma dependency and can ship to the browser.
 *
 * If you add a role: update Prisma enum + re-run migrate + update the RBAC
 * matrix in `src/rbac/index.ts`.
 */
export const ROLES = ['company_owner', 'property_manager', 'staff', 'tenant', 'guardian'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Billing period format — `YYYY-MM` (ISO 8601 calendar month).
 * All invoices, meter readings, and ledger entries use this string.
 */
export const PERIOD_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Slug format used for `company.slug`, `property.slug`, path-based routing
 * `/c/:companySlug/...`. Lowercase alphanumeric + hyphen, 2–64 chars, must
 * start/end with alphanumeric. Reserved for URL safety.
 */
export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const SLUG_MIN_LEN = 2 as const;
export const SLUG_MAX_LEN = 64 as const;
