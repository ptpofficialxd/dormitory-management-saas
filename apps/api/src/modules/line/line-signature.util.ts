import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Pure HMAC-SHA256 verification for the LINE Messaging API webhook.
 *
 * LINE signs the **raw request body** with the channel secret and ships the
 * base64-encoded digest in the `X-Line-Signature` header. Spec:
 *   https://developers.line.biz/en/reference/messaging-api/#signature-validation
 *
 * Why this lives in its own file (not in the controller / service):
 *   - Pure function. Zero DI, zero IO. Trivial to unit-test exhaustively.
 *   - CLAUDE.md §7 lists "LINE webhook signature verification" as
 *     hand-written + AI-reviewed code. Keeping it small + isolated keeps the
 *     review surface small.
 *
 * Implementation notes:
 *   - `node:crypto` (NOT `Bun.*`) per ADR-0006 — must run on Node too.
 *   - `timingSafeEqual` requires equal-length buffers; we short-circuit on
 *     length mismatch BEFORE the constant-time compare to avoid throwing.
 *     This early-exit only leaks "the signature has wrong length" which is
 *     a structural property an attacker already controls — not secret.
 *   - Body is `Buffer` (raw bytes captured by Fastify's contentTypeParser).
 *     Never re-stringify: JSON.stringify(parsedBody) loses key order and
 *     whitespace and will silently fail signature verification.
 */
export function verifyLineSignature(args: {
  rawBody: Buffer;
  signatureHeader: string | string[] | undefined;
  channelSecret: string;
}): boolean {
  const { rawBody, signatureHeader, channelSecret } = args;

  // Header may arrive as `string | string[]` from Fastify when the same
  // header is set multiple times (pathological for a webhook, but type-safe).
  // We pick the first value — LINE only ever sends one. Reject empty.
  const headerValue = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!headerValue || typeof headerValue !== 'string' || headerValue.length === 0) {
    return false;
  }

  // Channel secret is required and must be non-empty. Defensive: a misconfigured
  // tenant with empty secret should NEVER pass validation (would otherwise let
  // any request through because HMAC('') == HMAC('') trivially).
  if (!channelSecret || channelSecret.length === 0) {
    return false;
  }

  // Compute expected signature: HMAC-SHA256 over raw body, base64-encoded.
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest('base64');

  // base64 SHA-256 is always 44 chars (32 bytes encoded). If the header
  // length differs we know it's invalid without leaking timing on the
  // actual byte comparison.
  if (expected.length !== headerValue.length) {
    return false;
  }

  // Constant-time compare. Wrap in try/catch — `timingSafeEqual` throws on
  // length mismatch, which we already guarded above, but Node may add other
  // invariants in the future and we never want this to crash the request.
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(headerValue, 'utf8'));
  } catch {
    return false;
  }
}
