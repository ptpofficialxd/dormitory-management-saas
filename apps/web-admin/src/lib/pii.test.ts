import { describe, expect, it } from 'vitest';
import { formatNationalId, formatPhone, maskNationalId, maskPhone } from './pii';

/**
 * PII masking unit tests.
 *
 * These helpers run on EVERY tenant render — bugs leak full PII to admin
 * eyes that should be masked, or worse, mask actual data needed for
 * disambiguation. Cover the well-formed Thai shape + the degenerate
 * cases (null / undefined / typo'd input) so we never crash a Server
 * Component on render and never silently leak.
 */

describe('maskPhone', () => {
  it('masks middle 3 digits of a canonical 10-digit Thai mobile', () => {
    expect(maskPhone('0812345678')).toBe('081-***-5678');
  });

  it('strips non-digits before masking (formatted input)', () => {
    expect(maskPhone('081-234-5678')).toBe('081-***-5678');
  });

  it('passes wrong-length input through unchanged (avoid silent corruption)', () => {
    // Don't return "***-***-***" on a typo — admin should SEE the bad data.
    expect(maskPhone('123')).toBe('123');
    expect(maskPhone('081234567890')).toBe('081234567890');
  });

  it('returns em-dash placeholder on null / undefined / empty', () => {
    expect(maskPhone(null)).toBe('—');
    expect(maskPhone(undefined)).toBe('—');
    expect(maskPhone('')).toBe('—');
  });
});

describe('maskNationalId', () => {
  it('masks all but the last 3 digits (formatted as XX-X tail) of a 13-digit ID', () => {
    expect(maskNationalId('1234567890123')).toBe('X-XXXX-XXXXX-12-3');
  });

  it('strips dashes before masking (formatted input)', () => {
    expect(maskNationalId('1-2345-67890-12-3')).toBe('X-XXXX-XXXXX-12-3');
  });

  it('passes wrong-length input through unchanged', () => {
    expect(maskNationalId('123')).toBe('123');
  });

  it('returns em-dash placeholder on null / undefined', () => {
    expect(maskNationalId(null)).toBe('—');
    expect(maskNationalId(undefined)).toBe('—');
  });
});

describe('formatPhone (reveal mode)', () => {
  it('formats a canonical 10-digit number with dashes', () => {
    expect(formatPhone('0812345678')).toBe('081-234-5678');
  });

  it('idempotent: re-formatting an already-formatted number yields the same shape', () => {
    expect(formatPhone('081-234-5678')).toBe('081-234-5678');
  });

  it('passes wrong-length input through unchanged', () => {
    expect(formatPhone('123')).toBe('123');
  });

  it('returns em-dash placeholder on null / undefined', () => {
    expect(formatPhone(null)).toBe('—');
    expect(formatPhone(undefined)).toBe('—');
  });
});

describe('formatNationalId (reveal mode)', () => {
  it('formats a 13-digit ID into Thai standard 1-2345-67890-12-3', () => {
    expect(formatNationalId('1234567890123')).toBe('1-2345-67890-12-3');
  });

  it('idempotent: dashes-in is dashes-out', () => {
    expect(formatNationalId('1-2345-67890-12-3')).toBe('1-2345-67890-12-3');
  });

  it('passes wrong-length input through unchanged', () => {
    expect(formatNationalId('123')).toBe('123');
  });
});
