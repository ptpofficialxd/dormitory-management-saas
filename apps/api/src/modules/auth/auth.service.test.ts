import { describe, expect, it } from 'vitest';
import { AuthService } from './auth.service.js';
import { JwtService } from './jwt.service.js';

/**
 * Narrow unit tests focused on the parts of `AuthService` that DON'T require
 * a live DB. Full login + refresh flows are covered by the e2e tests in
 * `test/auth.e2e-test.ts`, which run against a seeded Postgres.
 */
describe('AuthService — token plumbing', () => {
  const jwt = new JwtService();
  const svc = new AuthService(jwt);

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

  // Sanity: service actually wires jwt in.
  it('constructs without throwing', () => {
    expect(svc).toBeInstanceOf(AuthService);
  });
});
