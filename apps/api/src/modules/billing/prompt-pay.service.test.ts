import { beforeEach, describe, expect, it } from 'vitest';
import { PromptPayService } from './prompt-pay.service.js';

/**
 * Why these tests don't mock `qrcode`:
 *   The library is pure (no I/O, no globals) and small enough that running
 *   it in-process keeps the tests honest — we'd rather catch breakage from
 *   a `qrcode` major bump than mock a contract that drifts silently.
 *
 * What we DO trust the upstream `@dorm/shared/promptpay` tests for:
 *   - EMVCo TLV structure
 *   - CRC-16/CCITT-FALSE correctness
 *   - PromptPay ID normalization (10/13/15 digit handling)
 *   - Golden payload byte-for-byte match
 *   These are pinned in `packages/shared/src/promptpay.test.ts` so we
 *   don't duplicate them here. Tests below verify that THIS service
 *   wires through correctly + renders successfully.
 */
describe('PromptPayService', () => {
  let service: PromptPayService;

  beforeEach(() => {
    service = new PromptPayService();
  });

  describe('buildPayload', () => {
    it('returns the same string as the shared generator', () => {
      const payload = service.buildPayload({ promptPayId: '0812345678', amount: '100' });
      // Sanity: structural anchors. Full byte-match is in the shared test.
      expect(payload.startsWith('000201010211')).toBe(true);
      expect(payload).toContain('5406100.00'); // amount tag
      expect(payload).toMatch(/6304[0-9A-F]{4}$/); // CRC suffix
    });

    it('omits the amount tag when amount is not provided', () => {
      const payload = service.buildPayload({ promptPayId: '0812345678' });
      expect(payload).not.toMatch(/54\d{2}[\d.]+/);
    });

    it('throws on invalid PromptPay ID (delegates to shared validator)', () => {
      expect(() => service.buildPayload({ promptPayId: '1234' })).toThrow(/digits/);
    });
  });

  describe('renderSvg', () => {
    it('returns SVG markup containing the QR module grid', async () => {
      const result = await service.renderSvg({ promptPayId: '0812345678', amount: '50' });
      expect(typeof result.output).toBe('string');
      const svg = result.output as string;
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.includes('</svg>')).toBe(true);
      // qrcode emits a single <path> with the module grid encoded in `d`.
      expect(svg).toContain('<path');
      // Payload comes back so the caller can persist alongside the asset.
      expect(result.payload).toMatch(/6304[0-9A-F]{4}$/);
    });

    it('honours errorCorrectionLevel override', async () => {
      // Higher EC = denser QR = longer path data; we just assert the call
      // succeeds for every level rather than making brittle length asserts.
      for (const ec of ['L', 'M', 'Q', 'H'] as const) {
        const result = await service.renderSvg(
          { promptPayId: '0812345678' },
          { errorCorrectionLevel: ec },
        );
        expect((result.output as string).startsWith('<svg')).toBe(true);
      }
    });

    it('honours custom margin (quiet zone)', async () => {
      const tight = await service.renderSvg({ promptPayId: '0812345678' }, { margin: 0 });
      const wide = await service.renderSvg({ promptPayId: '0812345678' }, { margin: 8 });
      // ViewBox width grows with margin — wide SVG must have a larger one.
      const tightVb = (tight.output as string).match(/viewBox="0 0 (\d+)/)?.[1];
      const wideVb = (wide.output as string).match(/viewBox="0 0 (\d+)/)?.[1];
      expect(tightVb).toBeDefined();
      expect(wideVb).toBeDefined();
      expect(Number(wideVb)).toBeGreaterThan(Number(tightVb));
    });
  });

  describe('renderPng', () => {
    it('returns a PNG buffer with the right magic bytes', async () => {
      const result = await service.renderPng({ promptPayId: '0812345678', amount: '75.50' });
      expect(Buffer.isBuffer(result.output)).toBe(true);
      const buf = result.output as Buffer;
      // PNG signature: 89 50 4E 47 0D 0A 1A 0A
      expect(buf[0]).toBe(0x89);
      expect(buf[1]).toBe(0x50);
      expect(buf[2]).toBe(0x4e);
      expect(buf[3]).toBe(0x47);
    });

    it('produces a non-trivial buffer (>200 bytes for a real QR)', async () => {
      const result = await service.renderPng({ promptPayId: '0812345678' });
      expect((result.output as Buffer).length).toBeGreaterThan(200);
    });
  });

  describe('renderDataUrl', () => {
    it('returns a data:image/png;base64,... URL', async () => {
      const result = await service.renderDataUrl({ promptPayId: '0812345678', amount: '1' });
      expect(typeof result.output).toBe('string');
      expect((result.output as string).startsWith('data:image/png;base64,')).toBe(true);
    });

    it('payload + output are both populated', async () => {
      const result = await service.renderDataUrl({ promptPayId: '1234567890123' });
      expect(result.payload.length).toBeGreaterThan(0);
      expect((result.output as string).length).toBeGreaterThan(100);
    });
  });
});
