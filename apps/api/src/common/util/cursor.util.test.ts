import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { buildCursorPage, decodeCursor, encodeCursor } from './cursor.util.js';

describe('cursor.util — encode/decode', () => {
  it('round-trips a (createdAt, id) payload through base64url', () => {
    const payload = {
      createdAt: '2026-04-22T10:00:00.000Z',
      id: '11111111-1111-1111-8111-111111111111',
    };
    const encoded = encodeCursor(payload);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
    expect(decodeCursor(encoded)).toEqual(payload);
  });

  it('rejects garbage input with 400 (not 500)', () => {
    expect(() => decodeCursor('!!!not-base64!!!')).toThrow(BadRequestException);
  });

  it('rejects valid base64 of non-JSON with 400', () => {
    const bad = Buffer.from('plain text not json', 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(BadRequestException);
  });

  it('rejects JSON missing required fields', () => {
    const bad = Buffer.from(JSON.stringify({ id: 'abc' }), 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(BadRequestException);
  });

  it('rejects payload with non-ISO createdAt', () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: 'last tuesday', id: 'abc' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(BadRequestException);
  });
});

describe('cursor.util — buildCursorPage', () => {
  type Row = { id: string; createdAt: Date; name: string };
  const mkRow = (n: number): Row => ({
    id: `id-${n}`,
    createdAt: new Date(`2026-04-${String(n).padStart(2, '0')}T00:00:00Z`),
    name: `row-${n}`,
  });

  it('returns nextCursor=null when result count ≤ limit', () => {
    const page = buildCursorPage([mkRow(1), mkRow(2)], 5);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(2);
  });

  it('trims overflow row + emits cursor pointing at LAST RETURNED row', () => {
    const rows = [mkRow(1), mkRow(2), mkRow(3)]; // Caller queried with take = limit + 1.
    const page = buildCursorPage(rows, 2);

    expect(page.items).toHaveLength(2);
    expect(page.items[1]?.id).toBe('id-2'); // Trimmed boundary, NOT the overflow row.
    // biome-ignore lint/style/noNonNullAssertion: nextCursor present per assertion above
    const decoded = decodeCursor(page.nextCursor!);
    expect(decoded.id).toBe('id-2');
    expect(decoded.createdAt).toBe('2026-04-02T00:00:00.000Z');
  });

  it('handles exactly `limit` items as the terminal page', () => {
    const page = buildCursorPage([mkRow(1), mkRow(2)], 2);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(2);
  });
});
