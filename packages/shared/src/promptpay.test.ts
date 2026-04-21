import { describe, expect, it } from 'vitest';
import { crc16Ccitt, generatePromptPayPayload, normalizePromptPayId } from './promptpay.js';

describe('crc16Ccitt', () => {
  it('CRC("123456789") = 29B1 (canonical test vector)', () => {
    expect(crc16Ccitt('123456789')).toBe('29B1');
  });

  it('CRC("") = FFFF (init value, no iterations)', () => {
    expect(crc16Ccitt('')).toBe('FFFF');
  });

  it('returns exactly 4 uppercase hex chars', () => {
    expect(crc16Ccitt('hello')).toMatch(/^[0-9A-F]{4}$/);
  });
});

describe('normalizePromptPayId', () => {
  it('normalizes 10-digit phone starting with 0', () => {
    expect(normalizePromptPayId('0812345678')).toEqual({
      kind: 'phone',
      value: '0066812345678',
      subTag: '01',
    });
  });

  it('strips non-digits from phone', () => {
    expect(normalizePromptPayId('081-234-5678')).toEqual({
      kind: 'phone',
      value: '0066812345678',
      subTag: '01',
    });
  });

  it('passes through 13-digit national ID', () => {
    expect(normalizePromptPayId('1234567890123')).toEqual({
      kind: 'national_id',
      value: '1234567890123',
      subTag: '02',
    });
  });

  it('passes through 15-digit e-wallet', () => {
    expect(normalizePromptPayId('123456789012345')).toEqual({
      kind: 'ewallet',
      value: '123456789012345',
      subTag: '03',
    });
  });

  it('throws on wrong length', () => {
    expect(() => normalizePromptPayId('12345')).toThrow(/digits/);
    expect(() => normalizePromptPayId('')).toThrow();
  });

  it('throws on 10-digit that does not start with 0', () => {
    expect(() => normalizePromptPayId('1234567890')).toThrow();
  });
});

describe('generatePromptPayPayload — structure', () => {
  it('static QR with 10-digit phone + no amount', () => {
    const payload = generatePromptPayPayload({ promptPayId: '0812345678' });

    // Payload Format Indicator — tag 00, len 02, value "01"
    expect(payload.startsWith('000201')).toBe(true);
    // Static Point-of-Initiation — tag 01, len 02, value "11"
    expect(payload.slice(6, 12)).toBe('010211');
    // Currency (tag 53, len 03, value "764") must appear
    expect(payload).toContain('5303764');
    // Country (tag 58, len 02, value "TH")
    expect(payload).toContain('5802TH');
    // No tag 54 when amount is omitted
    expect(payload).not.toMatch(/54\d{2}[\d.]+/);
    // Ends with CRC (tag 63, len 04, 4 hex chars)
    expect(payload).toMatch(/6304[0-9A-F]{4}$/);
  });

  it('static QR with national ID + amount', () => {
    const payload = generatePromptPayPayload({
      promptPayId: '1234567890123',
      amount: '5500',
    });

    // Merchant account sub-field 02 (national ID) inside tag 29
    expect(payload).toContain('0213' + '1234567890123');
    // Amount field 54 — "5500.00" is 7 chars, length "07"
    expect(payload).toContain('5407' + '5500.00');
  });

  it('CRC at the end is valid — recomputing over the rest matches', () => {
    const payload = generatePromptPayPayload({
      promptPayId: '0812345678',
      amount: '100.50',
    });

    const withoutCrc = payload.slice(0, -4);
    const providedCrc = payload.slice(-4);
    expect(crc16Ccitt(withoutCrc)).toBe(providedCrc);
  });

  it('AID matches PromptPay spec (A000000677010111)', () => {
    const payload = generatePromptPayPayload({ promptPayId: '0812345678' });
    expect(payload).toContain('0016A000000677010111');
  });

  it('amount uses dot as decimal separator, no thousands grouping', () => {
    const payload = generatePromptPayPayload({
      promptPayId: '0812345678',
      amount: '12345.67',
    });
    expect(payload).toContain('5408' + '12345.67');
    expect(payload).not.toContain(','); // No grouping in QR payload
  });

  it('amount rounds HALF_UP to 2dp', () => {
    const payload = generatePromptPayPayload({
      promptPayId: '0812345678',
      amount: '100.567', // → 100.57
    });
    expect(payload).toContain('5406' + '100.57');
  });
});

describe('generatePromptPayPayload — golden output', () => {
  // Pinned to detect accidental changes in payload construction.
  // Phone 0812345678 (→ 0066812345678), amount 100.00.
  it('matches known-good payload for phone + 100 THB', () => {
    const payload = generatePromptPayPayload({
      promptPayId: '0812345678',
      amount: '100',
    });
    // Field-by-field expectation:
    //   00 02 01              Payload format
    //   01 02 11              Static
    //   29 37 [AID=00 16 A000000677010111] [01 13 0066812345678]
    //   53 03 764             Currency
    //   54 06 100.00          Amount
    //   58 02 TH              Country
    //   63 04 <CRC>
    const expectedWithoutCrc =
      '000201' +
      '010211' +
      '2937' +
      '0016A000000677010111' +
      '01130066812345678' +
      '5303764' +
      '5406100.00' +
      '5802TH' +
      '6304';
    const expectedCrc = crc16Ccitt(expectedWithoutCrc);
    expect(payload).toBe(expectedWithoutCrc + expectedCrc);
  });
});
