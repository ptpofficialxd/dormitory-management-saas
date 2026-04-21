/**
 * Auth e2e — exercises POST /auth/login + /auth/refresh + GET /c/:slug/me
 * against a live Postgres seeded with the standard 2-company fixture.
 *
 * Pre-req: `bun run --filter @dorm/db seed` (or use the seed.ts helpers
 * directly). The test reuses the seeded credentials — see `packages/db/src/seed.ts`.
 */

import { disconnect } from '@dorm/db';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    // Quiet by default; flip to `['error', 'warn']` when debugging 5xx
    // traces surfaced by GlobalExceptionFilter.
    logger: false,
  });
  await app.init();
  // Required for Fastify — wires routes onto the underlying server.
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
  await disconnect();
});

describe('POST /auth/login', () => {
  it('issues a token pair on valid credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        companySlug: 'acme-dorm',
        email: 'owner@acme-dorm.test',
        password: 'acme-demo-pw-1234',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.accessTokenExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects wrong password with 401 + opaque message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        companySlug: 'acme-dorm',
        email: 'owner@acme-dorm.test',
        password: 'wrong-password-123',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/Invalid credentials/);
  });

  it('rejects unknown company with the SAME 401 (no enumeration)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        companySlug: 'no-such-dorm',
        email: 'owner@acme-dorm.test',
        password: 'acme-demo-pw-1234',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/Invalid credentials/);
  });

  it('rejects malformed input via the global ZodValidationPipe', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { companySlug: 'X', email: 'not-an-email', password: '123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ValidationFailed');
  });
});

describe('POST /auth/refresh', () => {
  it('rotates a refresh token into a new access token', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        companySlug: 'acme-dorm',
        email: 'owner@acme-dorm.test',
        password: 'acme-demo-pw-1234',
      },
    });
    const { refreshToken } = login.json();

    const refresh = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });
    expect(refresh.statusCode).toBe(200);
    const body = refresh.json();
    expect(body.accessToken).not.toBe(login.json().accessToken);
  });

  it('rejects an access token used as a refresh token', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        companySlug: 'acme-dorm',
        email: 'owner@acme-dorm.test',
        password: 'acme-demo-pw-1234',
      },
    });
    const { accessToken } = login.json();

    const refresh = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: accessToken },
    });
    expect(refresh.statusCode).toBe(401);
  });
});

describe('GET /c/:companySlug/me — path-company guard', () => {
  it('returns the current user/company on a matching slug', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        companySlug: 'acme-dorm',
        email: 'owner@acme-dorm.test',
        password: 'acme-demo-pw-1234',
      },
    });
    const { accessToken } = login.json();

    const me = await app.inject({
      method: 'GET',
      url: '/c/acme-dorm/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.company.slug).toBe('acme-dorm');
    expect(body.user.email).toBe('owner@acme-dorm.test');
    expect(body.roles).toContain('company_owner');
  });

  it('refuses a mismatched slug with 403 (cross-tenant URL smuggling)', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        companySlug: 'acme-dorm',
        email: 'owner@acme-dorm.test',
        password: 'acme-demo-pw-1234',
      },
    });
    const { accessToken } = login.json();

    const me = await app.inject({
      method: 'GET',
      url: '/c/beta-apts/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(me.statusCode).toBe(403);
  });

  it('rejects missing bearer token with 401', async () => {
    const me = await app.inject({ method: 'GET', url: '/c/acme-dorm/me' });
    expect(me.statusCode).toBe(401);
  });
});

describe('GET /health — public ping', () => {
  it('returns ok without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});
