import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { env } from '../../config/env.js';

/**
 * Verifies a LINE LIFF `liff.getIDToken()` JWT against LINE's official
 * verification endpoint and extracts the `lineUserId` (`sub` claim).
 *
 * Why call LINE's HTTP verify endpoint instead of validating the JWT locally?
 *
 *   1. LINE's signing keys rotate without notice and they don't publish a
 *      stable JWKS endpoint with usable cache headers. Local verify means
 *      we'd need a key-fetch-and-cache layer with rotation handling — more
 *      surface area for "stale key → all tokens reject in prod" outages.
 *   2. The verify endpoint also runs LINE-side checks beyond signature
 *      (token-revoked / channel-deactivated / user-deleted) that a static
 *      JWKS validation would miss.
 *   3. Latency cost is one HTTPS call per redeem — acceptable for a
 *      one-time-per-tenant binding flow. Not on the hot path.
 *
 * Endpoint: POST https://api.line.me/oauth2/v2.1/verify
 * Body (form-urlencoded):
 *   id_token=<jwt>
 *   client_id=<LIFF_LOGIN_CHANNEL_ID>
 *
 * Success response (200 JSON):
 *   { iss, sub, aud, exp, iat, name?, picture?, email? }
 *
 * Failure: 4xx with `{error, error_description}`. We map every 4xx to
 * `UnauthorizedException` (401 INVALID_LINE_ID_TOKEN). 5xx / network
 * failures bubble up as 502-class errors so the client can retry.
 *
 * `aud` is double-checked locally even though we passed `client_id` — defence
 * in depth against a misconfigured LINE response.
 */
const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify' as const;
const REQUEST_TIMEOUT_MS = 5_000 as const;

/** Verified payload — only the fields the redeem flow consumes. */
export type VerifiedLineIdToken = {
  /** `sub` — opaque LINE userId (≤ 33 chars in practice). Bound to the tenant. */
  lineUserId: string;
  /** `aud` — the LIFF channel id. Verified to equal env.LIFF_LOGIN_CHANNEL_ID. */
  audience: string;
  /** `exp` — token expiry (epoch seconds). Past-exp tokens fail verify. */
  expiresAt: Date;
};

@Injectable()
export class LineIdTokenVerifier {
  private readonly logger = new Logger(LineIdTokenVerifier.name);

  /**
   * Verify and return the trusted claims. Throws `UnauthorizedException`
   * with `error: 'INVALID_LINE_ID_TOKEN'` on any verify failure — the
   * controller surfaces a 401 to the client, never a stack trace.
   */
  async verify(idToken: string): Promise<VerifiedLineIdToken> {
    const body = new URLSearchParams({
      id_token: idToken,
      client_id: env.LIFF_LOGIN_CHANNEL_ID,
    }).toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(LINE_VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      // Network / DNS / abort. Logged as warning — operator may want to
      // alert on a flood of these (LINE outage or our outbound is broken).
      this.logger.warn(`LINE verify network failure: ${(err as Error).message}`);
      throw new UnauthorizedException({
        error: 'INVALID_LINE_ID_TOKEN',
        message: 'LINE id-token verification is temporarily unavailable',
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // 4xx from LINE — token rejected. We log the body for forensics but
      // never echo it to the client (could leak channel-id confusion etc.).
      const errorBody = await safeReadBody(response);
      this.logger.warn(
        `LINE verify rejected (status=${response.status}): ${errorBody.slice(0, 256)}`,
      );
      throw new UnauthorizedException({
        error: 'INVALID_LINE_ID_TOKEN',
        message: 'LINE id-token is invalid or expired',
      });
    }

    const payload = (await response.json()) as Partial<{
      sub: string;
      aud: string;
      exp: number;
      iss: string;
    }>;

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      this.logger.warn('LINE verify response missing `sub` claim');
      throw new UnauthorizedException({
        error: 'INVALID_LINE_ID_TOKEN',
        message: 'LINE id-token is missing a subject claim',
      });
    }
    if (payload.aud !== env.LIFF_LOGIN_CHANNEL_ID) {
      this.logger.warn(`LINE verify aud mismatch: got '${payload.aud ?? '<missing>'}'`);
      throw new UnauthorizedException({
        error: 'INVALID_LINE_ID_TOKEN',
        message: 'LINE id-token audience does not match this LIFF app',
      });
    }
    if (typeof payload.exp !== 'number') {
      throw new UnauthorizedException({
        error: 'INVALID_LINE_ID_TOKEN',
        message: 'LINE id-token is missing exp claim',
      });
    }

    return {
      lineUserId: payload.sub,
      audience: payload.aud,
      expiresAt: new Date(payload.exp * 1000),
    };
  }
}

/**
 * Read up to 1 KiB of response body for logging. Never throws — falls back
 * to an empty string. Mirrors `line-messaging.client.ts` `safeReadBody`.
 */
async function safeReadBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 1024 ? `${text.slice(0, 1024)}…[truncated]` : text;
  } catch {
    return '';
  }
}
