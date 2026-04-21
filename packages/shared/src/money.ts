/**
 * Money helpers — wraps `decimal.js` so the whole app has ONE way to
 * construct / add / format currency values.
 *
 * Why `decimal.js` and not `Prisma.Decimal`?
 *   - `Prisma.Decimal` is `decimal.js-light` internally, but importing
 *     `@prisma/client` into shared would pull Prisma into the browser bundle
 *     (LIFF app). `@dorm/shared` must stay runtime-agnostic.
 *   - `decimal.js` and `Prisma.Decimal` share wire format (string serialization),
 *     so converting is `new Decimal(prismaValue.toString())` and
 *     `new Prisma.Decimal(sharedValue.toFixed(2))`.
 *
 * Invariants (CLAUDE.md §3.3, ADR-0005):
 *   - NEVER use `number` / `Float` for money. Always `Money` (= `Decimal`)
 *     or a string like `"5500.00"`.
 *   - Scale is ALWAYS 2 (satang precision) at the boundary — internally the
 *     library holds arbitrary precision; we only clamp to 2dp when we
 *     serialize or persist.
 *   - Rounding mode is **HALF_UP** (RoundingMode.ROUND_HALF_UP = 0 wait —
 *     decimal.js uses ROUND_HALF_UP = 4). We align with Thai Revenue
 *     Department practice: round half away from zero.
 */

import Decimal from 'decimal.js';
import { CURRENCY_THB, LOCALE_TH, MONEY_SCALE } from './constants.js';

/** Strongly-named alias — keeps call-site intent clear. */
export type Money = Decimal;
export type MoneyInput = Decimal | string | number;

// Configure decimal.js globally for the package. Matches Prisma's runtime
// (precision=20, ROUND_HALF_UP) so values round-trip without surprises.
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

/**
 * Construct a `Money` from string / Decimal / (carefully) number.
 *
 * `number` is accepted for ergonomics but ONLY for small literal constants
 * in code (`money(100)`). Never pass a JS-floated user value — upstream
 * parsing should keep currency as string.
 */
export function money(input: MoneyInput): Money {
  if (input instanceof Decimal) return input;
  if (typeof input === 'string') {
    // Reject empty / whitespace early — `new Decimal('')` throws anyway but
    // the error message is "DecimalError: [DecimalError] Invalid argument: "
    // which is unhelpful.
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new Error('money(): empty string is not a valid amount');
    }
    return new Decimal(trimmed);
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new Error(`money(): non-finite number: ${input}`);
    }
    // Force through string conversion — avoids picking up JS float noise
    // (e.g. `0.1 + 0.2` → `0.30000000000000004`).
    return new Decimal(input.toString());
  }
  throw new Error(`money(): unsupported input type: ${typeof input}`);
}

/** `0` as a Money — useful for reducers / default values. */
export const ZERO: Money = new Decimal(0);

// -----------------------------------------------------------------------
// Arithmetic — thin wrappers that keep `Money` in / `Money` out.
// -----------------------------------------------------------------------

export function add(a: MoneyInput, b: MoneyInput): Money {
  return money(a).plus(money(b));
}

export function sub(a: MoneyInput, b: MoneyInput): Money {
  return money(a).minus(money(b));
}

export function mul(a: MoneyInput, factor: MoneyInput): Money {
  return money(a).times(money(factor));
}

export function div(a: MoneyInput, divisor: MoneyInput): Money {
  const d = money(divisor);
  if (d.isZero()) {
    throw new Error('money(): division by zero');
  }
  return money(a).div(d);
}

/** Sum over an iterable — returns `ZERO` on empty input. */
export function sum(values: Iterable<MoneyInput>): Money {
  let acc: Money = ZERO;
  for (const v of values) acc = acc.plus(money(v));
  return acc;
}

// -----------------------------------------------------------------------
// Comparisons.
// -----------------------------------------------------------------------

export function isZero(m: MoneyInput): boolean {
  return money(m).isZero();
}

export function isNegative(m: MoneyInput): boolean {
  return money(m).isNegative();
}

export function eq(a: MoneyInput, b: MoneyInput): boolean {
  return money(a).eq(money(b));
}

export function lt(a: MoneyInput, b: MoneyInput): boolean {
  return money(a).lt(money(b));
}

export function lte(a: MoneyInput, b: MoneyInput): boolean {
  return money(a).lte(money(b));
}

export function gt(a: MoneyInput, b: MoneyInput): boolean {
  return money(a).gt(money(b));
}

export function gte(a: MoneyInput, b: MoneyInput): boolean {
  return money(a).gte(money(b));
}

// -----------------------------------------------------------------------
// Serialization.
// -----------------------------------------------------------------------

/**
 * Clamp to 2dp + return fixed-point string like `"5500.00"`. Use this when
 * writing to the DB (Prisma `Decimal(10,2)`) or to JSON APIs.
 *
 * Rounds HALF_UP at the 2dp boundary.
 */
export function toStorage(m: MoneyInput): string {
  return money(m).toFixed(MONEY_SCALE, Decimal.ROUND_HALF_UP);
}

/**
 * Display-formatted THB amount, e.g. `"฿5,500.00"`.
 *
 * Uses `Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' })`.
 * Browsers and Node 20+ render the ฿ symbol consistently.
 */
export function formatTHB(m: MoneyInput): string {
  // Intl takes number, not string. We've already clamped to 2dp with HALF_UP
  // so `parseFloat(toStorage(m))` is safe for rendering (no binary-float
  // precision loss at 2dp for the magnitudes dorm rent uses, sub-millions).
  const fixed = toStorage(m);
  return new Intl.NumberFormat(LOCALE_TH, {
    style: 'currency',
    currency: CURRENCY_THB,
    minimumFractionDigits: MONEY_SCALE,
    maximumFractionDigits: MONEY_SCALE,
  }).format(Number.parseFloat(fixed));
}

/**
 * Parse a user-entered THB string — tolerant of:
 *   - leading / trailing whitespace
 *   - `฿` prefix / trailing ` บาท`
 *   - thousand-separator commas
 *   - leading `+` / `-`
 *
 * Returns `null` on parse failure — callers decide whether to treat that as
 * a validation error or zero.
 */
export function parseTHB(input: string): Money | null {
  const cleaned = input
    .trim()
    .replace(/฿|บาท|THB|,/gi, '')
    .replace(/\s+/g, '');
  if (cleaned.length === 0) return null;
  try {
    const d = new Decimal(cleaned);
    if (!d.isFinite()) return null;
    return d;
  } catch {
    return null;
  }
}
