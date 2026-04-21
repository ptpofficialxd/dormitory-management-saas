import { describe, expect, it } from 'vitest';
import {
  assertSlug,
  getReservedSlugs,
  normalizeSlug,
  validateSlug,
} from './slug.js';

describe('validateSlug', () => {
  it.each([
    ['acme-dorm', true],
    ['a1', true],
    ['tower-a', true],
    ['a-b-c-1-2-3', true],
    ['12345', true],
    ['a'.repeat(64), true],
  ])('accepts "%s"', (input, expected) => {
    expect(validateSlug(input).ok).toBe(expected);
  });

  it('rejects too short', () => {
    expect(validateSlug('a')).toEqual({ ok: false, error: 'too_short' });
  });

  it('rejects too long', () => {
    expect(validateSlug('a'.repeat(65))).toEqual({
      ok: false,
      error: 'too_long',
    });
  });

  it.each([
    'Acme',       // uppercase
    'acme dorm',  // space
    'acme_dorm',  // underscore
    '-acme',      // leading hyphen
    'acme-',      // trailing hyphen
    'acme!',      // punctuation
    'หอ',         // Thai
    'acme.dorm',  // dot
  ])('rejects invalid chars: "%s"', (input) => {
    expect(validateSlug(input)).toEqual({ ok: false, error: 'invalid_chars' });
  });

  it('rejects reserved slugs', () => {
    expect(validateSlug('admin')).toEqual({ ok: false, error: 'reserved' });
    expect(validateSlug('api')).toEqual({ ok: false, error: 'reserved' });
    expect(validateSlug('webhooks')).toEqual({ ok: false, error: 'reserved' });
  });
});

describe('assertSlug', () => {
  it('returns input on valid', () => {
    expect(assertSlug('acme-dorm')).toBe('acme-dorm');
  });

  it('throws on invalid', () => {
    expect(() => assertSlug('Acme')).toThrow(/invalid_chars/);
    expect(() => assertSlug('admin')).toThrow(/reserved/);
  });
});

describe('normalizeSlug', () => {
  it.each([
    ['ACME Dorm', 'acme-dorm'],
    ['  acme___dorm  ', 'acme-dorm'],
    ['acme!!!dorm', 'acmedorm'],
    ['--acme--dorm--', 'acme-dorm'],
    ['acme   dorm', 'acme-dorm'],
    ['acme-dorm-123', 'acme-dorm-123'],
    // Thai strips out — should produce empty string, caller must handle.
    ['หอพัก ACME', 'acme'],
    ['a'.repeat(100), 'a'.repeat(64)],
  ])('"%s" → "%s"', (input, expected) => {
    expect(normalizeSlug(input)).toBe(expected);
  });

  it('pure-Thai input yields empty string (caller must reject)', () => {
    expect(normalizeSlug('หอพัก')).toBe('');
  });

  it('result round-trips through validateSlug when 2+ chars remain', () => {
    const normalized = normalizeSlug('  ACME Dorm 2026  ');
    expect(normalized).toBe('acme-dorm-2026');
    expect(validateSlug(normalized).ok).toBe(true);
  });
});

describe('getReservedSlugs', () => {
  it('returns a sorted non-empty list', () => {
    const list = getReservedSlugs();
    expect(list.length).toBeGreaterThan(10);
    expect([...list]).toEqual([...list].sort());
  });
});
