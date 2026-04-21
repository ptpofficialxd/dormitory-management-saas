import { randomUUID } from 'node:crypto';
import { type AdminJwtClaims, adminJwtClaimsSchema } from '@dorm/shared/zod';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { type JWTPayload, SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env.js';

/**
 * Subset of {@link AdminJwtClaims} that callers must supply when minting a
 * token — the time-related claims (`iat`, `exp`, `typ`) are filled in by
 * this service so the call sites stay short.
 */
export type IssueClaimsInput = Omit<AdminJwtClaims, 'typ' | 'iat' | 'exp'>;

/**
 * jose-based HS256 wrapper for admin auth.
 *
 * Why jose (not jsonwebtoken)?
 *   * ESM-native, no `require` shim needed under Bun/Node interop (ADR-0006).
 *   * No CVEs in the 5.x line + active maintenance.
 *   * Strict typing for header/claims, with explicit `typ` validation.
 *
 * Token shape:
 *   * `typ: 'access'`  → short-lived (default 15m), used as `Bearer …`.
 *   * `typ: 'refresh'` → long-lived (default 30d), exchanged at /auth/refresh.
 *
 * The `typ` claim discriminates the two so a refresh token CANNOT be replayed
 * as an access token (and vice versa). `verifyAccessToken` / `verifyRefreshToken`
 * each enforce the expected `typ` and refuse the other.
 */
@Injectable()
export class JwtService {
  private readonly secret = new TextEncoder().encode(env.JWT_SECRET);
  private readonly issuer = 'dorm-api';
  private readonly audience = 'dorm-admin';

  /** Sign an access token. Returns the JWT and its absolute expiry (UNIX seconds). */
  async signAccessToken(claims: IssueClaimsInput): Promise<{ token: string; expiresAt: number }> {
    return this.sign(claims, 'access', env.JWT_ACCESS_TTL);
  }

  /** Sign a refresh token. Same shape as an access token but `typ: 'refresh'`. */
  async signRefreshToken(claims: IssueClaimsInput): Promise<{ token: string; expiresAt: number }> {
    return this.sign(claims, 'refresh', env.JWT_REFRESH_TTL);
  }

  /**
   * Verify an access token. Throws {@link UnauthorizedException} on any
   * failure (bad sig, expired, wrong typ, schema mismatch). Never leaks
   * the underlying jose error to callers — leakage helps attackers
   * distinguish "token malformed" from "secret wrong".
   */
  async verifyAccessToken(token: string): Promise<AdminJwtClaims> {
    return this.verify(token, 'access');
  }

  /** Verify a refresh token. Same error semantics as `verifyAccessToken`. */
  async verifyRefreshToken(token: string): Promise<AdminJwtClaims> {
    return this.verify(token, 'refresh');
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private async sign(
    claims: IssueClaimsInput,
    typ: 'access' | 'refresh',
    ttl: string,
  ): Promise<{ token: string; expiresAt: number }> {
    // `jti` (RFC 7519 §4.1.7) — per-token nonce so two tokens minted in the
    // same second with identical claims still produce distinct JWT strings.
    // Without this, back-to-back `signAccessToken()` calls collide under
    // HS256 (deterministic signature over identical payloads).
    const jwt = await new SignJWT({ ...claims, typ })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setJti(randomUUID())
      .setIssuedAt()
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setExpirationTime(ttl)
      .sign(this.secret);

    // Round-trip to extract `exp` so we don't have to re-implement TTL parsing
    // (jose accepts strings like '15m' / '1h' / '30d').
    const decoded = await jwtVerify(jwt, this.secret, {
      issuer: this.issuer,
      audience: this.audience,
    });
    return { token: jwt, expiresAt: decoded.payload.exp ?? 0 };
  }

  private async verify(token: string, expectedTyp: 'access' | 'refresh'): Promise<AdminJwtClaims> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.secret, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['HS256'],
      });
      payload = result.payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const parsed = adminJwtClaimsSchema.safeParse(payload);
    if (!parsed.success) {
      // Schema drift → treat as invalid. Don't expose Zod issues.
      throw new UnauthorizedException('Invalid token claims');
    }
    if (parsed.data.typ !== expectedTyp) {
      throw new UnauthorizedException('Wrong token type');
    }
    return parsed.data;
  }
}
