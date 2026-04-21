/**
 * RLS isolation test (CLAUDE.md §6 Definition of Done).
 *
 * Proves:
 *   1. A tenant can read only its own rows.
 *   2. A tenant cannot INSERT rows belonging to another company (WITH CHECK).
 *   3. A caller with no tenant context reads zero rows (default-deny).
 *   4. Bypass mode sees everything (for platform admin paths).
 *   5. Audit log is append-only — UPDATE/DELETE throw.
 *
 * Prerequisite: `bun run db:setup` has been run against the test DB.
 * Run with: `bun run test` in packages/db.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { disconnect, prisma, rawPrisma } from './client.js';
import { withTenant } from './tenant-context.js';

let companyAId: string;
let companyBId: string;

beforeAll(async () => {
  // Locate the two seeded companies.
  const [a, b] = await withTenant({ companyId: '', bypassRls: true }, () =>
    Promise.all([
      prisma.company.findUnique({ where: { slug: 'acme-dorm' } }),
      prisma.company.findUnique({ where: { slug: 'beta-apts' } }),
    ]),
  );

  if (!a || !b) {
    throw new Error(
      'Seed data not found. Run `bun run db:setup` before running this test.',
    );
  }

  companyAId = a.id;
  companyBId = b.id;
});

afterAll(async () => {
  await disconnect();
});

describe('RLS — read isolation', () => {
  it('Company A reads only its own properties', async () => {
    const props = await withTenant({ companyId: companyAId }, () =>
      prisma.property.findMany(),
    );
    expect(props).toHaveLength(1);
    expect(props[0]?.companyId).toBe(companyAId);
  });

  it('Company B reads only its own properties', async () => {
    const props = await withTenant({ companyId: companyBId }, () =>
      prisma.property.findMany(),
    );
    expect(props).toHaveLength(1);
    expect(props[0]?.companyId).toBe(companyBId);
  });

  it('Company A sees only its own units (2 seeded)', async () => {
    const units = await withTenant({ companyId: companyAId }, () =>
      prisma.unit.findMany(),
    );
    expect(units).toHaveLength(2);
    for (const u of units) expect(u.companyId).toBe(companyAId);
  });

  it('No tenant context → zero rows (default-deny)', async () => {
    // Direct hit on rawPrisma with no AsyncLocalStorage — RLS returns nothing.
    const props = await rawPrisma.property.findMany();
    expect(props).toHaveLength(0);
  });
});

describe('RLS — write isolation (WITH CHECK)', () => {
  it('Company A cannot insert a property claiming companyId = B', async () => {
    await expect(
      withTenant({ companyId: companyAId }, () =>
        prisma.property.create({
          data: {
            companyId: companyBId, // attempting cross-tenant write
            slug: 'evil',
            name: 'should fail',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('RLS — bypass mode', () => {
  it('bypassRls = true sees all companies', async () => {
    const companies = await withTenant({ companyId: '', bypassRls: true }, () =>
      prisma.company.findMany(),
    );
    expect(companies.length).toBeGreaterThanOrEqual(2);
    const slugs = companies.map((c) => c.slug).sort();
    expect(slugs).toContain('acme-dorm');
    expect(slugs).toContain('beta-apts');
  });
});

describe('audit_log — append-only trigger', () => {
  it('UPDATE on audit_log is rejected', async () => {
    await withTenant({ companyId: companyAId, bypassRls: true }, async () => {
      await prisma.auditLog.create({
        data: {
          companyId: companyAId,
          action: 'test.update',
          resource: 'test',
          metadata: { seeded: true } as Prisma.InputJsonValue,
        },
      });
    });

    await expect(
      withTenant({ companyId: '', bypassRls: true }, () =>
        prisma.$executeRawUnsafe(
          `UPDATE audit_log SET action = 'tampered' WHERE action = 'test.update'`,
        ),
      ),
    ).rejects.toThrow(/append-only/i);
  });

  it('DELETE on audit_log is rejected', async () => {
    await expect(
      withTenant({ companyId: '', bypassRls: true }, () =>
        prisma.$executeRawUnsafe(
          `DELETE FROM audit_log WHERE action = 'test.update'`,
        ),
      ),
    ).rejects.toThrow(/append-only/i);
  });
});
