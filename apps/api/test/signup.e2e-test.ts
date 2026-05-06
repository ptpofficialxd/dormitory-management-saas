/**
 * Signup e2e — exercises POST /auth/signup + GET /auth/check-slug against a
 * live Postgres seeded with the standard 2-company fixture (Task #113).
 *
 * Pre-req: `bun run --filter @dorm/db seed` (so the existing slug `easyslip-dorm`
 * resolves to "taken" in the check-slug tests).
 *
 * Test isolation: each signup test mints a unique slug + email + cleans up
 * the company in `afterAll`. Since Task #116 dropped the audit_log triggers,
 * deleting the Company cascades to user / roleAssignment / audit_log via FK
 * Cascade — no superuser session needed.
 */

import { disconnect, prisma, withTenant } from '@dorm/db';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

let app: NestFastifyApplication;

/** Track every companyId we create so afterAll can cascade-delete them. */
const createdCompanyIds = new Set<string>();

function makeUniqueSlug(prefix: string): string {
  // Lowercase + hyphens only — matches SLUG_REGEX. `Date.now().toString(36)`
  // is short, monotonically increasing, and collision-free within a run.
  const tail = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return `${prefix}-${tail}`.toLowerCase();
}

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  // Cascade FK on audit_log/user/roleAssignment → company means a single
  // deleteMany on company is sufficient. Bypass RLS because rows span
  // multiple just-created companies. Allowed to call auditLog mutation
  // here because *.e2e-test.ts is excluded from the lint check.
  if (createdCompanyIds.size > 0) {
    const ids = [...createdCompanyIds];
    await withTenant({ companyId: '', bypassRls: true }, () =>
      prisma.company.deleteMany({ where: { id: { in: ids } } }),
    ).catch((err) => console.error('[signup-test] cleanup failed:', err));
  }
  await app.close();
  await disconnect();
});

// =========================================================================
// POST /auth/signup
// =========================================================================

describe('POST /auth/signup', () => {
  it('creates company + owner + role + audit row in one tx and returns tokens', async () => {
    const slug = makeUniqueSlug('signup-happy');
    const email = `owner+${Date.now()}@example.test`;

    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        companyName: 'Signup Happy Path Dorm',
        slug,
        ownerEmail: email,
        ownerPassword: 'correct-horse-battery',
        ownerDisplayName: 'Happy Owner',
        acceptTerms: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.accessTokenExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(body.companySlug).toBe(slug);
    expect(typeof body.companyId).toBe('string');
    createdCompanyIds.add(body.companyId);

    // Verify the DB graph landed correctly. Use bypass-RLS read so the test
    // doesn't have to thread the new companyId through `withTenant`.
    const company = await withTenant({ companyId: '', bypassRls: true }, () =>
      prisma.company.findUnique({
        where: { id: body.companyId },
        select: {
          slug: true,
          name: true,
          plan: true,
          trialEndsAt: true,
          users: { select: { email: true, displayName: true, emailVerifiedAt: true } },
          roleAssignments: { select: { role: true } },
          auditLogs: { select: { action: true, resource: true } },
        },
      }),
    );
    expect(company).toBeTruthy();
    expect(company?.slug).toBe(slug);
    expect(company?.name).toBe('Signup Happy Path Dorm');
    expect(company?.plan).toBe('free');
    expect(company?.trialEndsAt).toBeInstanceOf(Date);
    expect(company?.users[0]?.email).toBe(email);
    expect(company?.users[0]?.emailVerifiedAt).toBeNull();
    expect(company?.users[0]?.displayName).toBe('Happy Owner');
    expect(company?.roleAssignments[0]?.role).toBe('company_owner');
    expect(
      company?.auditLogs.some(
        (log) => log.action === 'signup.success' && log.resource === 'company',
      ),
    ).toBe(true);

    // Sanity: the issued access token can be used immediately to hit a
    // tenant-scoped endpoint (proves auto-login works end-to-end).
    const me = await app.inject({
      method: 'GET',
      url: `/c/${slug}/me`,
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().company.slug).toBe(slug);
    expect(me.json().roles).toContain('company_owner');
  });

  it('returns 409 SlugTaken when the slug already exists (seeded fixture)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        companyName: 'Duplicate Slug Dorm',
        slug: 'easyslip-dorm', // seeded
        ownerEmail: 'someone@example.test',
        ownerPassword: 'correct-horse-battery',
        ownerDisplayName: 'Dup Owner',
        acceptTerms: true,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SlugTaken');
  });

  it('returns 400 InvalidSlug for a reserved word', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        companyName: 'Reserved Slug Test',
        slug: 'admin', // reserved
        ownerEmail: 'a@example.test',
        ownerPassword: 'correct-horse-battery',
        ownerDisplayName: 'Owner',
        acceptTerms: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('InvalidSlug');
    expect(res.json().reason).toBe('reserved');
  });

  it('returns 400 ValidationFailed when acceptTerms is false', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        companyName: 'No Terms',
        slug: makeUniqueSlug('no-terms'),
        ownerEmail: 'a@example.test',
        ownerPassword: 'correct-horse-battery',
        ownerDisplayName: 'Owner',
        acceptTerms: false,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ValidationFailed');
  });

  it('returns 400 ValidationFailed for short password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        companyName: 'Short PW',
        slug: makeUniqueSlug('short-pw'),
        ownerEmail: 'a@example.test',
        ownerPassword: 'short',
        ownerDisplayName: 'Owner',
        acceptTerms: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ValidationFailed');
  });

  it('isolates two parallel signups — different slugs land in different tenancies', async () => {
    const slugA = makeUniqueSlug('iso-a');
    const slugB = makeUniqueSlug('iso-b');

    const [resA, resB] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: {
          companyName: 'Isolation A',
          slug: slugA,
          ownerEmail: 'a@iso.test',
          ownerPassword: 'correct-horse-battery',
          ownerDisplayName: 'A Owner',
          acceptTerms: true,
        },
      }),
      app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: {
          companyName: 'Isolation B',
          slug: slugB,
          ownerEmail: 'b@iso.test',
          ownerPassword: 'correct-horse-battery',
          ownerDisplayName: 'B Owner',
          acceptTerms: true,
        },
      }),
    ]);

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    const idA = resA.json().companyId;
    const idB = resB.json().companyId;
    expect(idA).not.toBe(idB);
    createdCompanyIds.add(idA);
    createdCompanyIds.add(idB);

    // Assert A's token cannot resolve B's /me endpoint (cross-tenant guard).
    const aTriesB = await app.inject({
      method: 'GET',
      url: `/c/${slugB}/me`,
      headers: { authorization: `Bearer ${resA.json().accessToken}` },
    });
    expect(aTriesB.statusCode).toBe(403);
  });
});

// =========================================================================
// GET /auth/check-slug
// =========================================================================

describe('GET /auth/check-slug', () => {
  it('returns available=true for a fresh, well-formed slug', async () => {
    const slug = makeUniqueSlug('chk-fresh');
    const res = await app.inject({ method: 'GET', url: `/auth/check-slug?slug=${slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true });
  });

  it('returns available=false reason=taken for a seeded slug', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/check-slug?slug=easyslip-dorm',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, reason: 'taken' });
  });

  it('returns available=false reason=reserved for a reserved word', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/check-slug?slug=admin' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, reason: 'reserved' });
  });

  it('returns available=false reason=invalid_chars for uppercase input', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/check-slug?slug=Acme' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, reason: 'invalid_chars' });
  });

  it('returns available=false reason=too_short for 1-char input', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/check-slug?slug=a' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, reason: 'too_short' });
  });

  it('rejects empty slug at the Zod layer (400)', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/check-slug?slug=' });
    expect(res.statusCode).toBe(400);
  });
});
