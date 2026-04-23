/**
 * Billing flow e2e — exercises the Invoice → Payment → Slip pipeline against
 * a live Postgres + the standard 2-company seed. Asserts the three contracts
 * we care most about for billing:
 *
 *   1. **Idempotency** (CLAUDE.md §3.10) — POST /payments with the same
 *      `Idempotency-Key` MUST return the SAME row, never a fresh insert.
 *   2. **Cross-tenant isolation** (CLAUDE.md §3.1, §3.2) — EASYSLIP admin
 *      cannot reach Beta invoices/payments via FK guess, GET, or LIST.
 *      RLS is the floor; service-layer FK pre-checks are the belt.
 *   3. **Audit log + invoice rollup** (CLAUDE.md §3.7, §3.4) — confirming
 *      a payment flips the invoice status atomically and writes one
 *      audit_log row per mutation.
 *
 * Pre-req: `bun run --filter @dorm/db seed` (creates easyslip-dorm + ptp-apts
 * with one owner + one property + two units each).
 *
 * Fixtures created INLINE (not added to the seed) under
 * `withTenant({ bypassRls: true })`:
 *   - Tenant per company
 *   - Active Contract per company (linked to one of the seeded units)
 *   - Issued Invoice per company (total = rentAmount)
 *
 * Cleanup: each `describe` block creates a UNIQUE Idempotency-Key so retries
 * across runs don't collide. Invoice/Tenant/Contract rows are NOT torn down
 * — the seed is idempotent and the rows are namespaced by run id.
 */

import { randomUUID } from 'node:crypto';
import { Prisma, disconnect, prisma, withTenant } from '@dorm/db';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

let app: NestFastifyApplication;

// Each test run gets a fresh suffix so re-runs don't trip uniqueness on
// (companyId, lineUserId) for Tenant or (contractId, period) for Invoice.
const RUN = Date.now().toString(36);

interface CompanyFixture {
  slug: string;
  companyId: string;
  ownerEmail: string;
  ownerPassword: string;
  accessToken: string;
  unitId: string;
  tenantId: string;
  contractId: string;
  invoiceId: string;
  invoiceTotal: string;
}

const EASYSLIP = {
  slug: 'easyslip-dorm',
  ownerEmail: 'easyslip@admin.com',
  ownerPassword: 'easyslipadmin1234',
} as const;
const PTP = {
  slug: 'ptp-apts',
  ownerEmail: 'ptpofficialxd@gmail.com',
  ownerPassword: 'ptpofficialxd1234',
} as const;

let easyslip: CompanyFixture;
let ptp: CompanyFixture;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  easyslip = await setupCompanyFixture(EASYSLIP);
  ptp = await setupCompanyFixture(PTP);
}, 30_000);

afterAll(async () => {
  await app.close();
  await disconnect();
});

// ===================================================================
// Fixture helpers
// ===================================================================

async function loginAs(slug: string, email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { companySlug: slug, email, password },
  });
  expect(res.statusCode).toBe(200);
  return res.json().accessToken as string;
}

/**
 * Build a per-company billing fixture: Tenant + Contract + Issued Invoice.
 * Runs under `withTenant({ bypassRls: true })` so we can write across
 * tenant boundaries from a single setup function.
 */
async function setupCompanyFixture(input: {
  slug: string;
  ownerEmail: string;
  ownerPassword: string;
}): Promise<CompanyFixture> {
  const accessToken = await loginAs(input.slug, input.ownerEmail, input.ownerPassword);

  return await withTenant({ companyId: '', bypassRls: true }, async () => {
    const company = await prisma.company.findUniqueOrThrow({
      where: { slug: input.slug },
      select: { id: true },
    });
    // Take the first unit we seeded — both companies have at least 2.
    const unit = await prisma.unit.findFirstOrThrow({
      where: { companyId: company.id },
      select: { id: true, baseRent: true },
    });

    // Tenant — `lineUserId` carries the run suffix to keep the
    // (companyId, lineUserId) unique across re-runs.
    const tenant = await prisma.tenant.upsert({
      where: {
        companyId_lineUserId: {
          companyId: company.id,
          lineUserId: `e2e-billing-${RUN}`,
        },
      },
      update: {},
      create: {
        companyId: company.id,
        lineUserId: `e2e-billing-${RUN}`,
        displayName: `E2E Tenant ${input.slug}`,
        status: 'active',
      },
    });

    // Contract — covers `2026-04` so the invoice period is deterministic.
    const contract = await prisma.contract.create({
      data: {
        companyId: company.id,
        unitId: unit.id,
        tenantId: tenant.id,
        startDate: new Date('2026-04-01'),
        endDate: null,
        rentAmount: unit.baseRent,
        depositAmount: unit.baseRent,
        status: 'active',
      },
    });

    // Invoice — issued state so the Payment flow accepts it. Period uses
    // the run suffix in the suffix portion is impossible (period is YYYY-MM
    // VARCHAR(7)), so we use a synthetic future period that's unlikely to
    // collide with concurrent runs of the same suite.
    const period = synthPeriod();
    const issueDate = new Date(`${period}-01T00:00:00.000Z`);
    const dueDate = new Date(`${period}-07T00:00:00.000Z`);
    const invoice = await prisma.invoice.create({
      data: {
        companyId: company.id,
        contractId: contract.id,
        unitId: unit.id,
        tenantId: tenant.id,
        period,
        issueDate,
        dueDate,
        subtotal: unit.baseRent,
        total: unit.baseRent,
        status: 'issued',
        items: {
          create: {
            companyId: company.id,
            kind: 'rent',
            description: `Rent ${period}`,
            quantity: new Prisma.Decimal('1.00'),
            unitPrice: unit.baseRent,
            lineTotal: unit.baseRent,
            sortOrder: 0,
          },
        },
      },
    });

    return {
      slug: input.slug,
      companyId: company.id,
      ownerEmail: input.ownerEmail,
      ownerPassword: input.ownerPassword,
      accessToken,
      unitId: unit.id,
      tenantId: tenant.id,
      contractId: contract.id,
      invoiceId: invoice.id,
      invoiceTotal: unit.baseRent.toString(),
    };
  });
}

/**
 * Build a YYYY-MM string that's offset from the run timestamp so concurrent
 * suite runs (CI matrix) and re-runs of the same suite each pick a distinct
 * period — keeps `(contractId, period) @unique` from biting us.
 */
function synthPeriod(): string {
  // Run-id is base36; map first 6 chars onto a 0..71-month window starting
  // at 2030-01 to stay clear of any "real" billing cycles a human might seed.
  const seed = Number.parseInt(RUN.slice(-4), 36) % 72;
  const year = 2030 + Math.floor(seed / 12);
  const month = (seed % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

// ===================================================================
// 1. Idempotency contract
// ===================================================================

describe('POST /c/:slug/payments — Idempotency-Key contract', () => {
  it('returns the SAME payment row on a replayed POST with the same key', async () => {
    const idemKey = `idem-${RUN}-${randomUUID()}`;
    const body = {
      invoiceId: easyslip.invoiceId,
      amount: '1000.00',
      method: 'promptpay',
    };

    const first = await app.inject({
      method: 'POST',
      url: `/c/${easyslip.slug}/payments`,
      headers: {
        authorization: `Bearer ${easyslip.accessToken}`,
        'idempotency-key': idemKey,
      },
      payload: body,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: `/c/${easyslip.slug}/payments`,
      headers: {
        authorization: `Bearer ${easyslip.accessToken}`,
        'idempotency-key': idemKey,
      },
      payload: body,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);

    // Defence-in-depth: only ONE row in the DB for this key.
    const count = await withTenant({ companyId: easyslip.companyId }, () =>
      prisma.payment.count({ where: { idempotencyKey: idemKey } }),
    );
    expect(count).toBe(1);
  });

  it('rejects POST without an Idempotency-Key with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/c/${easyslip.slug}/payments`,
      headers: { authorization: `Bearer ${easyslip.accessToken}` },
      payload: { invoiceId: easyslip.invoiceId, amount: '500.00', method: 'cash' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('IdempotencyKeyRequired');
  });
});

// ===================================================================
// 2. Cross-tenant isolation
// ===================================================================

describe('Cross-tenant isolation across the billing surface', () => {
  it('refuses POST /payments against a foreign tenant invoice (RLS hides the FK)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/c/${easyslip.slug}/payments`,
      headers: {
        authorization: `Bearer ${easyslip.accessToken}`,
        'idempotency-key': `idem-${RUN}-${randomUUID()}`,
      },
      // EASYSLIP admin tries to pay PTP's invoice — invoice is invisible
      // under EASYSLIP's RLS scope, service replies 400 InvalidInvoiceId.
      payload: { invoiceId: ptp.invoiceId, amount: '100.00', method: 'cash' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('InvalidInvoiceId');
  });

  it('GET /payments LIST excludes other tenants payments', async () => {
    // Seed one payment per company so both tenants have something to find.
    await postPayment(easyslip, '250.00');
    await postPayment(ptp, '350.00');

    const res = await app.inject({
      method: 'GET',
      url: `/c/${easyslip.slug}/payments?limit=100`,
      headers: { authorization: `Bearer ${easyslip.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ companyId: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((p) => p.companyId === easyslip.companyId)).toBe(true);
  });

  it('GET /payments/:id returns 404 when the id belongs to another tenant', async () => {
    const ptpPayment = await postPayment(ptp, '777.00');

    const res = await app.inject({
      method: 'GET',
      url: `/c/${easyslip.slug}/payments/${ptpPayment.id}`,
      headers: { authorization: `Bearer ${easyslip.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ===================================================================
// 3. Audit log + invoice rollup
// ===================================================================

describe('Audit log + invoice rollup on confirm', () => {
  it('flips invoice.status to `paid` AND writes an audit_log row on confirm', async () => {
    // Create a fresh fixture so the rollup math is deterministic — full
    // amount = the invoice total.
    const fixture = await setupCompanyFixture(EASYSLIP);
    const fullAmount = fixture.invoiceTotal;

    const create = await app.inject({
      method: 'POST',
      url: `/c/${fixture.slug}/payments`,
      headers: {
        authorization: `Bearer ${fixture.accessToken}`,
        'idempotency-key': `idem-${RUN}-${randomUUID()}`,
      },
      payload: { invoiceId: fixture.invoiceId, amount: fullAmount, method: 'cash' },
    });
    expect(create.statusCode).toBe(201);
    const paymentId = create.json().id as string;

    const confirm = await app.inject({
      method: 'POST',
      url: `/c/${fixture.slug}/payments/${paymentId}/confirm`,
      headers: { authorization: `Bearer ${fixture.accessToken}` },
      payload: { note: 'e2e cash receipt' },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe('confirmed');

    // Invoice rollup: total paid >= invoice.total → 'paid'.
    const invoice = await withTenant({ companyId: fixture.companyId }, () =>
      prisma.invoice.findUniqueOrThrow({
        where: { id: fixture.invoiceId },
        select: { status: true },
      }),
    );
    expect(invoice.status).toBe('paid');

    // Audit log: confirming a payment is a POST mutation — the global
    // AuditLogInterceptor MUST have written one row for this exact path.
    const audit = await withTenant({ companyId: fixture.companyId }, () =>
      prisma.auditLog.findFirst({
        where: {
          companyId: fixture.companyId,
          action: { contains: '/confirm' },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(audit).not.toBeNull();
    expect(audit?.resource).toBe('payment');
  });

  it('rejecting a pending payment writes an audit_log row + leaves invoice unchanged', async () => {
    const fixture = await setupCompanyFixture(EASYSLIP);
    const create = await app.inject({
      method: 'POST',
      url: `/c/${fixture.slug}/payments`,
      headers: {
        authorization: `Bearer ${fixture.accessToken}`,
        'idempotency-key': `idem-${RUN}-${randomUUID()}`,
      },
      payload: { invoiceId: fixture.invoiceId, amount: '100.00', method: 'promptpay' },
    });
    expect(create.statusCode).toBe(201);
    const paymentId = create.json().id as string;

    const reject = await app.inject({
      method: 'POST',
      url: `/c/${fixture.slug}/payments/${paymentId}/reject`,
      headers: { authorization: `Bearer ${fixture.accessToken}` },
      payload: { rejectionReason: 'wrong slip' },
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json().status).toBe('rejected');

    // Invoice stays at 'issued' — rejected payments don't count toward
    // paid_total, so no rollup happens.
    const invoice = await withTenant({ companyId: fixture.companyId }, () =>
      prisma.invoice.findUniqueOrThrow({
        where: { id: fixture.invoiceId },
        select: { status: true },
      }),
    );
    expect(invoice.status).toBe('issued');

    const audit = await withTenant({ companyId: fixture.companyId }, () =>
      prisma.auditLog.findFirst({
        where: {
          companyId: fixture.companyId,
          action: { contains: '/reject' },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(audit).not.toBeNull();
    expect(audit?.resource).toBe('payment');
  });
});

// ===================================================================
// Local helpers
// ===================================================================

/** POST a fresh `pending` payment against the fixture's invoice. */
async function postPayment(
  fixture: CompanyFixture,
  amount: string,
): Promise<{ id: string; status: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/c/${fixture.slug}/payments`,
    headers: {
      authorization: `Bearer ${fixture.accessToken}`,
      'idempotency-key': `idem-${RUN}-${randomUUID()}`,
    },
    payload: { invoiceId: fixture.invoiceId, amount, method: 'cash' },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}
