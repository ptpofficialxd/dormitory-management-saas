import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyLineSignature } from './line-signature.util.js';

/**
 * Pure-function unit tests — no DI, no Nest harness. We assert the
 * security-critical properties directly:
 *
 *   - Valid signature passes
 *   - Single bit flip in body fails
 *   - Single bit flip in signature fails
 *   - Wrong channel secret fails
 *   - Missing / empty signature header fails (no implicit accept)
 *   - Empty channel secret fails (no HMAC('') === HMAC('') exploit)
 *   - Header sent as `string[]` picks the first value
 *   - Length mismatch fails before timingSafeEqual sees it (guard branch)
 *   - Whitespace differences in body break signature (raw-body sensitivity)
 */

const SECRET = '0123456789abcdef0123456789abcdef';
const BODY_TEXT = JSON.stringify({
  destination: 'U1234567890',
  events: [{ type: 'message', timestamp: 1700000000000 }],
});

function signBody(body: Buffer | string, secret = SECRET): string {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return createHmac('sha256', secret).update(buf).digest('base64');
}

describe('verifyLineSignature', () => {
  it('returns true for a correct signature', () => {
    const rawBody = Buffer.from(BODY_TEXT, 'utf8');
    const sig = signBody(rawBody);
    expect(verifyLineSignature({ rawBody, signatureHeader: sig, channelSecret: SECRET })).toBe(
      true,
    );
  });

  it('returns false when the body is tampered with by a single byte', () => {
    const rawBody = Buffer.from(BODY_TEXT, 'utf8');
    const sig = signBody(rawBody);
    // Flip the first byte of the body (without changing length).
    const tampered = Buffer.from(rawBody);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    expect(
      verifyLineSignature({ rawBody: tampered, signatureHeader: sig, channelSecret: SECRET }),
    ).toBe(false);
  });

  it('returns false when the signature header is tampered with', () => {
    const rawBody = Buffer.from(BODY_TEXT, 'utf8');
    const sig = signBody(rawBody);
    // Swap the last char to its lowercase/uppercase counterpart — keeps length.
    const last = sig.slice(-1);
    const swapped = sig.slice(0, -1) + (last === 'a' ? 'b' : 'a');
    expect(verifyLineSignature({ rawBody, signatureHeader: swapped, channelSecret: SECRET })).toBe(
      false,
    );
  });

  it('returns false when the channel secret differs from the signer', () => {
    const rawBody = Buffer.from(BODY_TEXT, 'utf8');
    const sig = signBody(rawBody, 'wrong-secret-wrong-secret-wrong0');
    expect(verifyLineSignature({ rawBody, signatureHeader: sig, channelSecret: SECRET })).toBe(
      false,
    );
  });

  it('returns false when the signature header is missing', () => {
    const rawBody = Buffer.from(BODY_TEXT, 'utf8');
    expect(
      verifyLineSignature({ rawBody, signatureHeader: undefined, channelSecret: SECRET }),
    ).toBe(false);
  });

  it('returns false when the signature header is an empty string', () => {
    const rawBody = Buffer.from(BODY_TEXT, 'utf8');
    expect(verifyLineSignature({ rawBody, signatureHeader: '', channelSecret: SECRET })).toBe(
      false,
    );
  });

  it('returns false when the channel secret is empty (no HMAC empty exploit)', () => {
    const rawBody = Buffer.from(BODY_TEXT, 'utf8');
    // Even if attacker supplies a real-looking signature they computed with
    // the empty secret, we must reject because the tenant is misconfigured.
    const sigWithEmpty = signBody(rawBody, '');
    expect(verifyLineSignature({ rawBody, signatureHeader: sigWithEmpty, channelSecret: '' })).toBe(
      false,
    );
  });

  it('uses the first value when the header arrives as a string array', () => {
    const rawBody = Buffer.from(BODY_TEXT, 'utf8');
    const sig = signBody(rawBody);
    expect(
      verifyLineSignature({
        rawBody,
        signatureHeader: [sig, 'garbage-value'],
        channelSecret: SECRET,
      }),
    ).toBe(true);
  });

  it('returns false on length mismatch (short-circuit branch)', () => {
    const rawBody = Buffer.from(BODY_TEXT, 'utf8');
    expect(
      verifyLineSignature({ rawBody, signatureHeader: 'too-short', channelSecret: SECRET }),
    ).toBe(false);
  });

  it('is sensitive to whitespace in raw body (no JSON re-stringify)', () => {
    // Sign body without trailing newline.
    const original = Buffer.from(BODY_TEXT, 'utf8');
    const sig = signBody(original);
    // Add a single trailing newline — semantically identical JSON, different bytes.
    const reformatted = Buffer.from(`${BODY_TEXT}\n`, 'utf8');
    expect(
      verifyLineSignature({
        rawBody: reformatted,
        signatureHeader: sig,
        channelSecret: SECRET,
      }),
    ).toBe(false);
  });
});
