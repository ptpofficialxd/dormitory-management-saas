import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  ZERO,
  add,
  div,
  eq,
  formatTHB,
  gt,
  gte,
  isNegative,
  isZero,
  lt,
  lte,
  money,
  mul,
  parseTHB,
  sub,
  sum,
  toStorage,
} from './money.js';

describe('money() constructor', () => {
  it('accepts strings', () => {
    expect(money('5500.00').toString()).toBe('5500');
    expect(money('5500.50').toString()).toBe('5500.5');
  });

  it('accepts Decimal', () => {
    const d = new Decimal('1234.56');
    expect(money(d)).toBe(d);
  });

  it('accepts numbers (via string conversion — no float noise)', () => {
    // Classic 0.1+0.2 = 0.30000000000000004 trap — ensure we round-trip cleanly.
    expect(money(0.1).plus(money(0.2)).toFixed(2)).toBe('0.30');
  });

  it('rejects empty string', () => {
    expect(() => money('')).toThrow(/empty/);
    expect(() => money('   ')).toThrow(/empty/);
  });

  it('rejects non-finite numbers', () => {
    expect(() => money(Number.NaN)).toThrow(/non-finite/);
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });
});

describe('arithmetic', () => {
  it('add / sub / mul / div', () => {
    expect(add('5500', '200').toFixed(2)).toBe('5700.00');
    expect(sub('5500', '200').toFixed(2)).toBe('5300.00');
    expect(mul('5500', '1.07').toFixed(2)).toBe('5885.00'); // 7% VAT
    expect(div('5500', '2').toFixed(2)).toBe('2750.00');
  });

  it('div by zero throws', () => {
    expect(() => div('100', '0')).toThrow(/division by zero/);
  });

  it('sum of empty iterable is ZERO', () => {
    expect(sum([]).eq(ZERO)).toBe(true);
  });

  it('sum works on string inputs', () => {
    expect(sum(['5500.00', '200.50', '30.25']).toFixed(2)).toBe('5730.75');
  });
});

describe('comparisons', () => {
  it('eq / lt / lte / gt / gte', () => {
    expect(eq('100', '100.00')).toBe(true);
    expect(lt('99.99', '100')).toBe(true);
    expect(lte('100', '100')).toBe(true);
    expect(gt('100.01', '100')).toBe(true);
    expect(gte('100', '100')).toBe(true);
  });

  it('isZero / isNegative', () => {
    expect(isZero('0.00')).toBe(true);
    expect(isZero(ZERO)).toBe(true);
    expect(isNegative('-0.01')).toBe(true);
    expect(isNegative('0.00')).toBe(false);
  });
});

describe('toStorage — DB-ready Decimal(10,2)', () => {
  it('clamps to exactly 2 decimal places', () => {
    expect(toStorage('100')).toBe('100.00');
    expect(toStorage('100.5')).toBe('100.50');
    expect(toStorage('100.567')).toBe('100.57'); // HALF_UP
    expect(toStorage('100.565')).toBe('100.57'); // HALF_UP — `.565` → `.57`
    expect(toStorage('100.564')).toBe('100.56');
  });

  it('rounds negative values HALF_UP (away from zero)', () => {
    expect(toStorage('-100.565')).toBe('-100.57');
  });

  it('0.1 + 0.2 serializes cleanly', () => {
    expect(toStorage(add('0.1', '0.2'))).toBe('0.30');
  });
});

describe('formatTHB', () => {
  it('formats with ฿ symbol + comma separators', () => {
    // NOTE: `Intl` output varies slightly by Node/ICU version — we assert
    // substrings instead of exact string to be robust across CI envs.
    const formatted = formatTHB('5500');
    expect(formatted).toContain('5,500.00');
    expect(formatted).toMatch(/฿|THB/); // some runtimes render "THB" instead of "฿"
  });

  it('renders large numbers with grouping', () => {
    const formatted = formatTHB('1234567.89');
    expect(formatted).toContain('1,234,567.89');
  });

  it('renders zero', () => {
    const formatted = formatTHB('0');
    expect(formatted).toContain('0.00');
  });
});

describe('parseTHB', () => {
  it.each([
    ['5500', '5500'],
    ['5,500.00', '5500'],
    ['฿5,500.00', '5500'],
    ['  5500.50 บาท ', '5500.5'],
    ['THB 1,234.56', '1234.56'],
    ['-100', '-100'],
    ['+100', '100'],
  ])('parses "%s" → %s', (input, expected) => {
    const m = parseTHB(input);
    expect(m).not.toBeNull();
    expect(m?.toString()).toBe(expected);
  });

  it('returns null on garbage', () => {
    expect(parseTHB('abc')).toBeNull();
    expect(parseTHB('')).toBeNull();
    expect(parseTHB('   ')).toBeNull();
    expect(parseTHB('12.34.56')).toBeNull();
  });
});
