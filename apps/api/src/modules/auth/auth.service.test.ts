import { describe, expect, it } from 'vitest';
import { AuthService } from './auth.service.js';
import { JwtService } from './jwt.service.js';
import { LineIdTokenVerifier } from './line-id-token.verifier.js';

/**
 * Narrow unit tests focused on the parts of `AuthService` that DON'T require
 * a live DB. Full login + refresh flows are covered by the e2e tests in
 * `test/auth.e2e-test.ts`, which run against a seeded Postgres.
 */
describe('AuthService — token plumbing', () => {
  const jwt = new JwtService();
  // LineIdTokenVerifier is unused by these token-plumbing tests but the
  // constructor demands it (injected for /me/auth/exchange, covered e2e).
  const lineVerifier = new LineIdTokenVerifier();
  const svc = new AuthService(jwt, lineVerifier);

  it('exposes a stable timing-safe dummy hash of Argon2id shape', () => {
    const hash = AuthService.getTimingSafeDummyHash();
    expect(hash).toMatch(/^\$argon2id\$v=19\$/);
    // Long enough to avoid accidental hash-shape validation shortcuts.
    expect(hash.length).toBeGreaterThan(64);
  });

  it('jwt round-trips access + refresh tokens with correct `typ`', async () => {
    const claims = {
      sub: '11111111-1111-1111-8111-111111111111',
      companyId: '22222222-2222-2222-8222-222222222222',
      companySlug: 'dorm-alpha',
      email: 'owner@dorm-alpha.test',
      roles: ['company_owner'] as const,
    };

    const access = await jwt.signAccessToken({ ...claims, roles: [...claims.roles] });
    const refresh = await jwt.signRefreshToken({ ...claims, roles: [...claims.roles] });

    const verifiedAccess = await jwt.verifyAccessToken(access.token);
    expect(verifiedAccess.sub).toBe(claims.sub);
    expect(verifiedAccess.typ).toBe('access');

    const verifiedRefresh = await jwt.verifyRefreshToken(refresh.token);
    expect(verifiedRefresh.typ).toBe('refresh');
  });

  it('rejects a refresh token when used as an access token', async () => {
    const refresh = await jwt.signRefreshToken({
      sub: '11111111-1111-1111-8111-111111111111',
      companyId: '22222222-2222-2222-8222-222222222222',
      companySlug: 'dorm-alpha',
      email: 'owner@dorm-alpha.test',
      roles: ['company_owner'],
    });

    await expect(jwt.verifyAccessToken(refresh.token)).rejects.toThrow(/Wrong token type/);
  });

  it('rejects an access token when used as a refresh token', async () => {
    const access = await jwt.signAccessToken({
      sub: '11111111-1111-1111-8111-111111111111',
      companyId: '22222222-2222-2222-8222-222222222222',
      companySlug: 'dorm-alpha',
      email: 'owner@dorm-alpha.test',
      roles: ['company_owner'],
    });

    await expect(jwt.verifyRefreshToken(access.token)).rejects.toThrow(/Wrong token type/);
  });

  it('rejects a garbage token with the generic unauthorized message', async () => {
    await expect(jwt.verifyAccessToken('not-a-jwt')).rejects.toThrow(/Invalid or expired token/);
    await expect(jwt.verifyAccessToken('a.b.c')).rejects.toThrow(/Invalid or expired token/);
  });

  // ---------------------------------------------------------------------
  // Tenant (LIFF) tokens — same secret, different audience + typ='liff'
  // ---------------------------------------------------------------------

  it('jwt round-trips a tenant token with typ=liff', async () => {
    const tenantClaims = {
      sub: '88888888-8888-8888-8888-888888888888', // tenant.id
      companyId: '22222222-2222-2222-8222-222222222222',
      companySlug: 'dorm-alpha',
      lineUserId: 'U1234567890abcdef',
    };

    const tenant = await jwt.signTenantToken(tenantClaims);
    const verified = await jwt.verifyTenantToken(tenant.token);
    expect(verified.sub).toBe(tenantClaims.sub);
    expect(verified.lineUserId).toBe(tenantClaims.lineUserId);
    expect(verified.typ).toBe('liff');
  });

  it('rejects an admin token when used as a tenant token (audience mismatch)', async () => {
    const access = await jwt.signAccessToken({
      sub: '11111111-1111-1111-8111-111111111111',
      companyId: '22222222-2222-2222-8222-222222222222',
      companySlug: 'dorm-alpha',
      email: 'owner@dorm-alpha.test',
      roles: ['company_owner'],
    });

    await expect(jwt.verifyTenantToken(access.token)).rejects.toThrow(/Invalid or expired token/);
  });

  it('rejects a tenant token when used as an admin access token', async () => {
    const tenant = await jwt.signTenantToken({
      sub: '88888888-8888-8888-8888-888888888888',
      companyId: '22222222-2222-2222-8222-222222222222',
      companySlug: 'dorm-alpha',
      lineUserId: 'U1234567890abcdef',
    });

    await expect(jwt.verifyAccessToken(tenant.token)).rejects.toThrow(/Invalid or expired token/);
  });

  // Sanity: service actually wires jwt in.
  it('constructs without throwing', () => {
    expect(svc).toBeInstanceOf(AuthService);
  });
});
