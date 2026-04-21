/**
 * Date / time helpers for the `Asia/Bangkok` market.
 *
 * Invariants (CLAUDE.md §3.4):
 *   - ALL timestamps in DB / API are UTC (`timestamp with time zone` or ISO
 *     8601 Z strings).
 *   - ALL user-facing display is `Asia/Bangkok` wall-clock time (UTC+7, no
 *     DST), rendered with locale `th-TH`.
 *   - Billing periods use `YYYY-MM` — this is a Bangkok-local month, not a
 *     UTC month, because a landlord's "April bill" always means April on
 *     their calendar regardless of DB timezone.
 *
 * Dependencies: `date-fns-tz` v3 (tree-shakeable, works in the browser).
 */

import { addMonths, endOfMonth, format, parse, parseISO, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { LOCALE_TH, PERIOD_REGEX, TIMEZONE_BANGKOK } from './constants.js';

/**
 * Opaque nominal type — a string known to match `YYYY-MM`.
 * Not enforced structurally; use {@link assertPeriod} at boundaries.
 */
export type Period = string & { readonly __brand: 'Period' };

// -----------------------------------------------------------------------
// Period (YYYY-MM) — billing-cycle identifiers.
// -----------------------------------------------------------------------

export function assertPeriod(value: string): Period {
  if (!PERIOD_REGEX.test(value)) {
    throw new Error(`Invalid period (expected YYYY-MM): ${JSON.stringify(value)}`);
  }
  return value as Period;
}

export function isPeriod(value: unknown): value is Period {
  return typeof value === 'string' && PERIOD_REGEX.test(value);
}

/** Return the Bangkok-local current period, e.g. `"2026-04"`. */
export function currentPeriod(now: Date = new Date()): Period {
  const bkk = toZonedTime(now, TIMEZONE_BANGKOK);
  const yyyy = bkk.getFullYear().toString().padStart(4, '0');
  const mm = (bkk.getMonth() + 1).toString().padStart(2, '0');
  return `${yyyy}-${mm}` as Period;
}

/** Period arithmetic — e.g. `addPeriod('2026-01', 3)` → `'2026-04'`. */
export function addPeriod(period: Period, months: number): Period {
  const [y, m] = period.split('-').map(Number) as [number, number];
  // Compute in calendar math — avoid Date timezone surprises.
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}` as Period;
}

export function prevPeriod(period: Period): Period {
  return addPeriod(period, -1);
}

export function nextPeriod(period: Period): Period {
  return addPeriod(period, 1);
}

/**
 * Start instant (UTC) of a Bangkok-local period.
 * `'2026-04'` → `2026-03-31T17:00:00.000Z` (April 1 00:00 ICT).
 */
export function periodStartUtc(period: Period): Date {
  const [y, m] = period.split('-').map(Number) as [number, number];
  // Build the naive local date, then interpret as Bangkok time → UTC.
  const localStart = new Date(y, m - 1, 1, 0, 0, 0, 0);
  return fromZonedTime(localStart, TIMEZONE_BANGKOK);
}

/** Exclusive end (UTC) of a Bangkok-local period — same as next period's start. */
export function periodEndUtc(period: Period): Date {
  return periodStartUtc(nextPeriod(period));
}

/** Convert a UTC instant to the Bangkok-local period it falls in. */
export function periodOf(instant: Date): Period {
  return currentPeriod(instant);
}

// -----------------------------------------------------------------------
// UTC ↔ Bangkok conversion.
// -----------------------------------------------------------------------

/**
 * Convert a UTC `Date` to a `Date` representing the same wall-clock time in
 * Bangkok. Useful for `formatInTimeZone`-style manual formatting; for most
 * display work prefer {@link formatBangkok}.
 *
 * NOTE: the returned `Date` is "lying" about its timezone — its `.toISOString()`
 * will still print a UTC instant but with the Bangkok numbers. Treat it as a
 * presentational value only; never persist.
 */
export function toBangkok(utc: Date): Date {
  return toZonedTime(utc, TIMEZONE_BANGKOK);
}

/**
 * Interpret a Bangkok-local `Date` (where the fields — year/month/day/hour —
 * are the wall-clock numbers in Bangkok) and produce the corresponding UTC
 * instant. Inverse of {@link toBangkok}.
 */
export function fromBangkok(local: Date): Date {
  return fromZonedTime(local, TIMEZONE_BANGKOK);
}

// -----------------------------------------------------------------------
// Formatting.
// -----------------------------------------------------------------------

/**
 * Format a UTC instant as `th-TH` wall-clock in Bangkok.
 * Default pattern: `dd MMM yyyy, HH:mm` (e.g. `"21 เม.ย. 2026, 14:30"`).
 */
export function formatBangkok(utc: Date, pattern = 'dd MMM yyyy, HH:mm'): string {
  const local = toBangkok(utc);
  // date-fns `format` uses the system locale by default. We don't import
  // date-fns/locale here to avoid bloating LIFF bundles — callers who need
  // Thai month names can use Intl.DateTimeFormat directly. This default
  // yields English month abbreviations; override `pattern` or use
  // {@link formatBangkokIntl} for native Thai output.
  return format(local, pattern);
}

/**
 * Intl-based formatter — heavier but produces native Thai output
 * ("21 เมษายน 2569" — note Buddhist Era year by default unless you override).
 */
export function formatBangkokIntl(
  utc: Date,
  options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  },
): string {
  return new Intl.DateTimeFormat(LOCALE_TH, {
    ...options,
    timeZone: TIMEZONE_BANGKOK,
  }).format(utc);
}

// -----------------------------------------------------------------------
// Parse helpers — tolerant but explicit.
// -----------------------------------------------------------------------

/** Wrap `date-fns/parseISO` — returns `null` on invalid input instead of throwing. */
export function parseIsoUtc(input: string): Date | null {
  try {
    const d = parseISO(input);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/**
 * Parse a Bangkok-local date-time string (e.g. `"2026-04-21 14:30"`) and
 * return the corresponding UTC instant. `pattern` follows date-fns syntax.
 */
export function parseBangkok(input: string, pattern: string): Date | null {
  try {
    const localNaive = parse(input, pattern, new Date());
    if (Number.isNaN(localNaive.getTime())) return null;
    return fromZonedTime(localNaive, TIMEZONE_BANGKOK);
  } catch {
    return null;
  }
}

/**
 * Period → first/last day (Bangkok local, returned as `Date`).
 * Useful for date-pickers that want to default-select a period range.
 */
export function periodBoundsLocal(period: Period): { start: Date; end: Date } {
  const anchor = periodStartUtc(period);
  const local = toBangkok(anchor);
  return {
    start: startOfMonth(local),
    end: endOfMonth(local),
  };
}

/** Re-export `date-fns` primitives used by consumers to avoid version drift. */
export { addMonths, endOfMonth, startOfMonth };
