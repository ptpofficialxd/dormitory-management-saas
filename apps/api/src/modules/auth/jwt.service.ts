import { randomUUID } from 'node:crypto';
import {
  type AdminJwtClaims,
  type TenantJwtClaims,
  adminJwtClaimsSchema,
  tenantJwtClaimsSchema,
} from '@dorm/shared/zod';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { type JWTPayload, SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env.js';

/**
 * Subset of {@link AdminJwtClaims} that callers must supply when minting a
 * token — the time-related claims (`iat`, `exp`, `typ`) are filled in by
 * this service so the call sites stay short.
 */
export type IssueClaimsInput = Omit<AdminJwtClaims, 'typ' | 'iat' | 'exp'>;

/** Same shape contract for tenant tokens. */
export type IssueTenantClaimsInput = Omit<TenantJwtClaims, 'typ' | 'iat' | 'exp'>;

/**
 * jose-based HS256 wrapper for both admin (web) and tenant (LIFF) auth.
 *
 * Why jose (not jsonwebtoken)?
 *   * ESM-native, no `require` shim needed under Bun/Node interop (ADR-0006).
 *   * No CVEs in the 5.x line + active maintenance.
 *   * Strict typing for header/claims, with explicit `typ` validation.
 *
 * Two token families share the same `JWT_SECRET` but use distinct (issuer,
 * audience, typ) tuples so they can NEVER be confused for one another:
 *
 *   Admin tokens
 *     iss = 'dorm-api', aud = 'dorm-admin'
 *     typ = 'access' (default 15m) | 'refresh' (default 30d)
 *     used as Bearer on /c/:slug/* (admin web)
 *
 *   Tenant (LIFF) tokens
 *     iss = 'dorm-api', aud = 'dorm-liff'
 *     typ = 'liff' (literal, 1h to match LINE id-token TTL)
 *     used as Bearer on /me/* (LIFF tenant); no refresh — re-mint via
 *     POST /me/auth/exchange with a fresh liff.getIDToken()
 *
 * Cross-family confusion is rejected because:
 *   - jose's `jwtVerify` checks `audience` strictly — a tenant token sent to
 *     an admin-verifying call fails with "unexpected aud" before payload is
 *     even parsed (and vice-versa).
 *   - The `typ` claim is post-parse asserted to match what the verifier
 *     expects — defence in depth even if audience checks were ever skipped.
 */
@Injectable()
export class JwtService {
  private readonly secret = new TextEncoder().encode(env.JWT_SECRET);
  private readonly issuer = 'dorm-api';
  private readonly adminAudience = 'dorm-admin';
  private readonly tenantAudience = 'dorm-liff';

  /** TTL for tenant tokens. Hardcoded to match LINE idToken lifetime; promote
   * to env if dorms ever want shorter sessions. */
  private readonly tenantTtl = '1h';

  // -----------------------------------------------------------------------
  // Admin tokens
  // -----------------------------------------------------------------------

  /** Sign an admin access token. Returns the JWT and its absolute expiry. */
  async signAccessToken(claims: IssueClaimsInput): Promise<{ token: string; expiresAt: number }> {
    return this.signAdmin(claims, 'access', env.JWT_ACCESS_TTL);
  }

  /** Sign an admin refresh token. Same shape but `typ: 'refresh'`. */
  async signRefreshToken(claims: IssueClaimsInput): Promise<{ token: string; expiresAt: number }> {
    return this.signAdmin(claims, 'refresh', env.JWT_REFRESH_TTL);
  }

  /**
   * Verify an admin access token. Throws {@link UnauthorizedException} on
   * any failure (bad sig, expired, wrong typ, schema mismatch). Never leaks
   * the underlying jose error to callers.
   */
  async verifyAccessToken(token: string): Promise<AdminJwtClaims> {
    return this.verifyAdmin(token, 'access');
  }

  /** Verify an admin refresh token. Same error semantics as `verifyAccessToken`. */
  async verifyRefreshToken(token: string): Promise<AdminJwtClaims> {
    return this.verifyAdmin(token, 'refresh');
  }

  // -----------------------------------------------------------------------
  // Tenant (LIFF) tokens
  // -----------------------------------------------------------------------

  /**
   * Mint a tenant session token after a successful LIFF idToken exchange
   * (or as part of a first-time bind redeem response). The LIFF client
   * holds it in memory + sessionStorage and includes it as `Bearer <token>`
   * on `/me/*` requests.
   */
  async signTenantToken(
    claims: IssueTenantClaimsInput,
  ): Promise<{ token: string; expiresAt: number }> {
    const jwt = await new SignJWT({ ...claims, typ: 'liff' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setJti(randomUUID())
      .setIssuedAt()
      .setIssuer(this.issuer)
      .setAudience(this.tenantAudience)
      .setExpirationTime(this.tenantTtl)
      .sign(this.secret);

    const decoded = await jwtVerify(jwt, this.secret, {
      issuer: this.issuer,
      audience: this.tenantAudience,
    });
    return { token: jwt, expiresAt: decoded.payload.exp ?? 0 };
  }

  /**
   * Verify a tenant token from `/me/*` requests. Throws on any failure with
   * the generic `Invalid or expired token` message — never leaks why.
   *
   * An admin token presented here is rejected at the audience check inside
   * jose's `jwtVerify` (admin audience !== tenant audience). The post-parse
   * `typ === 'liff'` assertion is belt-and-braces.
   */
  async verifyTenantToken(token: string): Promise<TenantJwtClaims> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.secret, {
        issuer: this.issuer,
        audience: this.tenantAudience,
        algorithms: ['HS256'],
      });
      payload = result.payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const parsed = tenantJwtClaimsSchema.safeParse(payload);
    if (!parsed.success) {
      throw new UnauthorizedException('Invalid token claims');
    }
    if (parsed.data.typ !== 'liff') {
      throw new UnauthorizedException('Wrong token type');
    }
    return parsed.data;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private async signAdmin(
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
      .setAudience(this.adminAudience)
      .setExpirationTime(ttl)
      .sign(this.secret);

    // Round-trip to extract `exp` so we don't have to re-implement TTL parsing
    // (jose accepts strings like '15m' / '1h' / '30d').
    const decoded = await jwtVerify(jwt, this.secret, {
      issuer: this.issuer,
      audience: this.adminAudience,
    });
    return { token: jwt, expiresAt: decoded.payload.exp ?? 0 };
  }

  private async verifyAdmin(
    token: string,
    expectedTyp: 'access' | 'refresh',
  ): Promise<AdminJwtClaims> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.secret, {
        issuer: this.issuer,
        audience: this.adminAudience,
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
