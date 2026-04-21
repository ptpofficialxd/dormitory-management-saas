import { describe, expect, it } from 'vitest';
import {
  addPeriod,
  assertPeriod,
  currentPeriod,
  formatBangkokIntl,
  fromBangkok,
  isPeriod,
  nextPeriod,
  parseBangkok,
  parseIsoUtc,
  periodBoundsLocal,
  periodEndUtc,
  periodOf,
  periodStartUtc,
  prevPeriod,
  toBangkok,
} from './date.js';

describe('Period validation', () => {
  it.each(['2026-01', '2026-12', '1999-06', '2100-02'])('accepts %s', (p) => {
    expect(isPeriod(p)).toBe(true);
    expect(assertPeriod(p)).toBe(p);
  });

  it.each(['2026-13', '2026-00', '2026-1', '202-01', 'abc', '', '2026/01'])('rejects "%s"', (p) => {
    expect(isPeriod(p)).toBe(false);
    expect(() => assertPeriod(p)).toThrow();
  });
});

describe('Period arithmetic', () => {
  it('addPeriod', () => {
    expect(addPeriod(assertPeriod('2026-01'), 3)).toBe('2026-04');
    expect(addPeriod(assertPeriod('2026-11'), 3)).toBe('2027-02');
    expect(addPeriod(assertPeriod('2026-01'), -1)).toBe('2025-12');
    expect(addPeriod(assertPeriod('2026-01'), -13)).toBe('2024-12');
  });

  it('prevPeriod / nextPeriod', () => {
    expect(prevPeriod(assertPeriod('2026-01'))).toBe('2025-12');
    expect(nextPeriod(assertPeriod('2026-12'))).toBe('2027-01');
  });
});

describe('periodStartUtc / periodEndUtc (Bangkok UTC+7)', () => {
  it('April 2026 period starts at 2026-03-31T17:00:00Z', () => {
    // 2026-04-01 00:00 ICT = 2026-03-31 17:00 UTC
    expect(periodStartUtc(assertPeriod('2026-04')).toISOString()).toBe('2026-03-31T17:00:00.000Z');
  });

  it('April end = May start', () => {
    expect(periodEndUtc(assertPeriod('2026-04')).toISOString()).toBe(
      periodStartUtc(assertPeriod('2026-05')).toISOString(),
    );
  });
});

describe('periodOf / currentPeriod', () => {
  it('instant at 2026-04-01 00:30 ICT → period 2026-04', () => {
    // 00:30 ICT on Apr 1 is still Mar 31 17:30 UTC, but the Bangkok period is April.
    const utc = new Date('2026-03-31T17:30:00.000Z');
    expect(periodOf(utc)).toBe('2026-04');
  });

  it('instant at 2026-03-31 23:00 UTC → period 2026-04 (=06:00 ICT Apr 1)', () => {
    const utc = new Date('2026-03-31T23:00:00.000Z');
    expect(periodOf(utc)).toBe('2026-04');
  });

  it('instant at 2026-03-31 16:59 UTC → period 2026-03 (=23:59 ICT Mar 31)', () => {
    const utc = new Date('2026-03-31T16:59:00.000Z');
    expect(periodOf(utc)).toBe('2026-03');
  });

  it('currentPeriod() returns a valid period', () => {
    expect(isPeriod(currentPeriod())).toBe(true);
  });
});

describe('toBangkok / fromBangkok round-trip', () => {
  it('round-trips a UTC instant unchanged', () => {
    const utc = new Date('2026-04-21T07:30:00.000Z');
    const bkk = toBangkok(utc);
    const back = fromBangkok(bkk);
    expect(back.toISOString()).toBe(utc.toISOString());
  });

  it('Bangkok wall-clock is +7 from UTC', () => {
    // 07:30 UTC = 14:30 ICT
    const bkk = toBangkok(new Date('2026-04-21T07:30:00.000Z'));
    expect(bkk.getHours()).toBe(14);
    expect(bkk.getMinutes()).toBe(30);
  });
});

describe('formatBangkokIntl', () => {
  it('produces a non-empty Thai-locale string', () => {
    const utc = new Date('2026-04-21T07:30:00.000Z');
    const out = formatBangkokIntl(utc);
    expect(out.length).toBeGreaterThan(0);
    // Should contain "14" (Bangkok hour) somewhere in the formatted output.
    expect(out).toMatch(/14/);
  });
});

describe('parseIsoUtc', () => {
  it('parses valid ISO 8601', () => {
    expect(parseIsoUtc('2026-04-21T07:30:00.000Z')?.toISOString()).toBe('2026-04-21T07:30:00.000Z');
  });

  it('returns null on garbage', () => {
    expect(parseIsoUtc('not a date')).toBeNull();
    expect(parseIsoUtc('')).toBeNull();
  });
});

describe('parseBangkok', () => {
  it('treats input as Bangkok-local wall-clock', () => {
    const utc = parseBangkok('2026-04-21 14:30', 'yyyy-MM-dd HH:mm');
    expect(utc).not.toBeNull();
    // 14:30 ICT = 07:30 UTC
    expect(utc?.toISOString()).toBe('2026-04-21T07:30:00.000Z');
  });

  it('returns null on malformed input', () => {
    expect(parseBangkok('nope', 'yyyy-MM-dd HH:mm')).toBeNull();
  });
});

describe('periodBoundsLocal', () => {
  it('returns first and last day of the period in local time', () => {
    const { start, end } = periodBoundsLocal(assertPeriod('2026-04'));
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(3); // April (0-indexed)
    expect(end.getDate()).toBe(30);
    expect(end.getMonth()).toBe(3);
  });
});
