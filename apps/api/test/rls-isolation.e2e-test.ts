/**
 * RLS isolation e2e — proves that a logged-in user CANNOT see another
 * tenant's data through any of the API surfaces we expose today.
 *
 * Strategy:
 *   1. Log in as `owner@easyslip-dorm.test` (companyId = EasySlip).
 *   2. Hit `/c/easyslip-dorm/me` — must succeed and only see EasySlip data.
 *   3. Smuggle the same token to `/c/ptp-apts/me` — must 403 (PathCompanyGuard).
 *   4. As a defence-in-depth check, fetch `prisma.property.findMany()` inside a
 *      `withTenant` block scoped to EasySlip — confirm `ptp-apts.tower-a` is NOT
 *      returned, even though the row exists.
 *
 * This is required by CLAUDE.md §6 ("Isolation test: RLS verified with 2
 * companies on any new tenant-owned table").
 */

import { disconnect, prisma, withTenant } from '@dorm/db';
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
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
  await disconnect();
});

async function loginAs(slug: string, email: string, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { companySlug: slug, email, password },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { accessToken: string; refreshToken: string };
}

describe('RLS isolation between two seeded companies', () => {
  it('EasySlip owner sees EasySlip data on GET /c/easyslip-dorm/me', async () => {
    const { accessToken } = await loginAs(
      'easyslip-dorm',
      'easyslip@admin.com',
      'easyslipadmin1234',
    );

    const me = await app.inject({
      method: 'GET',
      url: '/c/easyslip-dorm/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().company.slug).toBe('easyslip-dorm');
  });

  it('EasySlip token cannot reach PTP namespace via URL', async () => {
    const { accessToken } = await loginAs(
      'easyslip-dorm',
      'easyslip@admin.com',
      'easyslipadmin1234',
    );

    const beta = await app.inject({
      method: 'GET',
      url: '/c/ptp-apts/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(beta.statusCode).toBe(403);
  });

  it('PTP token cannot reach EasySlip namespace via URL', async () => {
    const { accessToken } = await loginAs(
      'ptp-apts',
      'ptpofficialxd@gmail.com',
      'ptpofficialxd1234',
    );

    const acme = await app.inject({
      method: 'GET',
      url: '/c/easyslip-dorm/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(acme.statusCode).toBe(403);
  });

  it('DB-level RLS hides PTP rows from a query scoped to EasySlip', async () => {
    const acme = await prisma.company.findFirstOrThrow.bind(null);
    // Fetch EasySlip's id outside any tenant ctx via a bypass-RLS slug lookup —
    // mirrors what AuthService does at login.
    const acmeId = await withTenant({ companyId: '', bypassRls: true }, () =>
      prisma.company
        .findUniqueOrThrow({
          where: { slug: 'easyslip-dorm' },
          select: { id: true },
        })
        .then((r) => r.id),
    );

    const props = await withTenant({ companyId: acmeId }, () =>
      prisma.property.findMany({ select: { slug: true, companyId: true } }),
    );

    // Should ONLY see properties belonging to EasySlip — never PTP's `tower-a`.
    expect(props.length).toBeGreaterThan(0);
    expect(props.every((p) => p.companyId === acmeId)).toBe(true);
    expect(props.find((p) => p.slug === 'tower-a')).toBeUndefined();

    // Silence "unused binding" in case of future refactor.
    void acme;
  });
});
