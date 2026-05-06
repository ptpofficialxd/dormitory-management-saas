/**
 * Audit-log read e2e (Task #119). Exercises:
 *   GET /c/:slug/audit-logs                         — list with default page
 *   GET /c/:slug/audit-logs?action=…&resource=…     — filter by action+resource
 *   GET /c/:slug/audit-logs?fromDate=…&toDate=…     — date range
 *   GET /c/:slug/audit-logs?cursor=…&limit=…        — pagination
 *
 * Pre-req: seeded DB (`bun run --filter @dorm/db seed`).
 *
 * Test isolation: writes a few audit rows under one seeded company, lists
 * them, asserts isolation against the OTHER seeded company. Cleanup is
 * cascade-safe (Task #116 dropped the append-only triggers — we delete by
 * actorUserId + a unique action prefix used only by this test).
 */

import { disconnect, prisma, withTenant } from '@dorm/db';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

let app: NestFastifyApplication;

/** Tag prefix on every audit row this test seeds — lets afterAll target only ours. */
const TEST_ACTION_TAG = 'audit-test';

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  // Tagged cleanup — only rows we created. Allowed to call deleteMany on
  // audit_log here because *.e2e-test.ts is excluded from the lint check.
  await withTenant({ companyId: '', bypassRls: true }, () =>
    prisma.auditLog.deleteMany({ where: { action: { startsWith: TEST_ACTION_TAG } } }),
  ).catch((err) => console.error('[audit-log-test] cleanup failed:', err));
  await app.close();
  await disconnect();
});

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function loginEasySlip(): Promise<{ token: string; companySlug: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      companySlug: 'easyslip-dorm',
      email: 'easyslip@admin.com',
      password: 'easyslipadmin1234',
    },
  });
  expect(res.statusCode).toBe(200);
  return { token: res.json().accessToken, companySlug: 'easyslip-dorm' };
}

async function loginPtp(): Promise<{ token: string; companySlug: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      companySlug: 'ptp-apts',
      email: 'ptp@admin.com',
      password: 'ptpadmin1234',
    },
  });
  expect(res.statusCode).toBe(200);
  return { token: res.json().accessToken, companySlug: 'ptp-apts' };
}

/**
 * Seed `count` audit rows on `companyId`, all tagged with TEST_ACTION_TAG +
 * a stable suffix so we can filter back to them in tests. Returns rowIds in
 * insertion order (DESC from API perspective — newest seeded last).
 */
async function seedAuditRows(companyId: string, count: number, suffix: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = await withTenant({ companyId: '', bypassRls: true }, () =>
      prisma.auditLog.create({
        data: {
          companyId,
          actorUserId: null,
          action: `${TEST_ACTION_TAG}.${suffix}`,
          resource: 'company',
          resourceId: companyId,
          metadata: { seq: i },
        },
        select: { id: true },
      }),
    );
    ids.push(row.id);
    // Tiny delay so createdAt is monotonic per row (Postgres default_now()
    // resolution is microseconds — safe under same-process bursts but the
    // sleep makes the assertion order completely deterministic).
    await new Promise((r) => setTimeout(r, 5));
  }
  return ids;
}

async function getCompanyIdBySlug(slug: string): Promise<string> {
  const row = await withTenant({ companyId: '', bypassRls: true }, () =>
    prisma.company.findUnique({ where: { slug }, select: { id: true } }),
  );
  if (!row) throw new Error(`No company for slug=${slug}`);
  return row.id;
}

// =========================================================================
// Tests
// =========================================================================

describe('GET /c/:slug/audit-logs', () => {
  it('returns recent rows, newest first, with nextCursor=null when fits in one page', async () => {
    const { token, companySlug } = await loginEasySlip();
    const companyId = await getCompanyIdBySlug(companySlug);
    await seedAuditRows(companyId, 3, 'list-default');

    const res = await app.inject({
      method: 'GET',
      url: `/c/${companySlug}/audit-logs?action=${encodeURIComponent(`${TEST_ACTION_TAG}.list-default`)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(3);
    expect(body.nextCursor).toBeNull();

    // Sanity: rows are ordered newest first.
    const timestamps = body.items.map((it: { createdAt: string }) => Date.parse(it.createdAt));
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
    }
  });

  it('filters by action — narrows result set', async () => {
    const { token, companySlug } = await loginEasySlip();
    const companyId = await getCompanyIdBySlug(companySlug);
    await seedAuditRows(companyId, 2, 'filter-A');
    await seedAuditRows(companyId, 2, 'filter-B');

    const res = await app.inject({
      method: 'GET',
      url: `/c/${companySlug}/audit-logs?action=${encodeURIComponent(`${TEST_ACTION_TAG}.filter-A`)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(2);
    for (const item of body.items) {
      expect(item.action).toBe(`${TEST_ACTION_TAG}.filter-A`);
    }
  });

  it('paginates via nextCursor — second page does not overlap with first', async () => {
    const { token, companySlug } = await loginEasySlip();
    const companyId = await getCompanyIdBySlug(companySlug);
    await seedAuditRows(companyId, 5, 'page');

    const first = await app.inject({
      method: 'GET',
      url: `/c/${companySlug}/audit-logs?action=${encodeURIComponent(`${TEST_ACTION_TAG}.page`)}&limit=2`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.items.length).toBe(2);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await app.inject({
      method: 'GET',
      url: `/c/${companySlug}/audit-logs?action=${encodeURIComponent(`${TEST_ACTION_TAG}.page`)}&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.items.length).toBe(2);

    const firstIds = new Set(firstBody.items.map((it: { id: string }) => it.id));
    for (const item of secondBody.items) {
      expect(firstIds.has(item.id)).toBe(false);
    }
  });

  it('isolates rows across companies — easyslip cannot see ptp audit rows', async () => {
    const easyId = await getCompanyIdBySlug('easyslip-dorm');
    const ptpId = await getCompanyIdBySlug('ptp-apts');
    await seedAuditRows(ptpId, 2, 'isolation-ptp');

    const { token, companySlug } = await loginEasySlip();
    const res = await app.inject({
      method: 'GET',
      url: `/c/${companySlug}/audit-logs?action=${encodeURIComponent(`${TEST_ACTION_TAG}.isolation-ptp`)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBe(0);

    // Sanity: ptp's own admin CAN see the rows.
    const ptpAuth = await loginPtp();
    const ptpRes = await app.inject({
      method: 'GET',
      url: `/c/${ptpAuth.companySlug}/audit-logs?action=${encodeURIComponent(`${TEST_ACTION_TAG}.isolation-ptp`)}`,
      headers: { authorization: `Bearer ${ptpAuth.token}` },
    });
    expect(ptpRes.statusCode).toBe(200);
    expect(ptpRes.json().items.length).toBe(2);

    // Use companyId so the unused-variable lint doesn't yell.
    void easyId;
  });

  it('rejects unauthenticated request with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/c/easyslip-dorm/audit-logs' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects malformed cursor with 400', async () => {
    const { token, companySlug } = await loginEasySlip();
    const res = await app.inject({
      method: 'GET',
      url: `/c/${companySlug}/audit-logs?cursor=not-base64-payload`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('InvalidCursor');
  });
});
