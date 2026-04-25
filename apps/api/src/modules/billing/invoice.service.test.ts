import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { type MockInstance, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for InvoiceService — mocks `@dorm/db` + PromptPayService to keep
 * the suite DB-free and deterministic.
 *
 * Coverage focus:
 *   - companyId stamping from tenant context on INSERT
 *   - Cross-tenant FK guard: contractId pre-check rejects foreign contracts
 *   - Money math: lineTotal = quantity × unitPrice via decimal.js (no float drift)
 *   - P2002 on (contract_id, period) → 409 ConflictException DuplicateInvoice
 *   - Update narrowness: status PATCH → 400 (state machine bypass guard)
 *   - State machine — issue:
 *       draft → issued (happy)
 *       issued → issued (idempotent no-op + same promptPayRef)
 *       paid|void|partially_paid → 409 InvoiceNotDraft
 *       no PromptPay configured → 400
 *   - State machine — void:
 *       draft|issued|partially_paid → void (happy)
 *       void → void (idempotent no-op)
 *       paid → 409 InvoicePaid
 *   - Batch generation:
 *       skip rules: inactive_contract, duplicate_invoice,
 *                   missing_water_reading, missing_electric_reading
 *       race-window P2002 fallback → skip not throw
 *       additional items appended in order
 *       happy path stamps companyId + nested-write items
 *
 * RLS cross-company isolation is asserted in the e2e suite (Postgres-only).
 */

const mockInvoiceFindMany = vi.fn();
const mockInvoiceFindUnique = vi.fn();
const mockInvoiceFindFirst = vi.fn();
const mockInvoiceCreate = vi.fn();
const mockInvoiceUpdate = vi.fn();
const mockContractFindUnique = vi.fn();
const mockContractFindMany = vi.fn();
const mockMeterFindMany = vi.fn();
const mockReadingFindMany = vi.fn();
const mockCompanyFindUnique = vi.fn();
const mockGetTenantContext = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    invoice: {
      findMany: mockInvoiceFindMany,
      findUnique: mockInvoiceFindUnique,
      findFirst: mockInvoiceFindFirst,
      create: mockInvoiceCreate,
      update: mockInvoiceUpdate,
    },
    contract: {
      findUnique: mockContractFindUnique,
      findMany: mockContractFindMany,
    },
    meter: {
      findMany: mockMeterFindMany,
    },
    reading: {
      findMany: mockReadingFindMany,
    },
    company: {
      findUnique: mockCompanyFindUnique,
    },
  },
  getTenantContext: mockGetTenantContext,
  Prisma: {},
}));

const { InvoiceService } = await import('./invoice.service.js');
const { PromptPayService } = await import('./prompt-pay.service.js');

/**
 * Stand-in for `NotificationService` (Task #84). The service only calls
 * `enqueueInvoiceIssued` from `issue()` — we mock that one method and assert
 * the payload at the call-site. Producer-side errors are swallowed by the
 * real impl, so the mock just resolves.
 */
class FakeNotificationService {
  enqueueInvoiceIssued = vi.fn().mockResolvedValue(undefined);
  enqueuePaymentApproved = vi.fn().mockResolvedValue(undefined);
  enqueuePaymentRejected = vi.fn().mockResolvedValue(undefined);
}

const COMPANY_ID = '11111111-1111-1111-8111-111111111111';
const CONTRACT_ID = '22222222-2222-2222-8222-222222222222';
const FOREIGN_CONTRACT_ID = '99999999-9999-9999-8999-999999999999';
const UNIT_ID = '33333333-3333-3333-8333-333333333333';
const TENANT_ID = '44444444-4444-4444-8444-444444444444';
const INVOICE_ID = '55555555-5555-5555-8555-555555555555';
const WATER_METER_ID = '66666666-6666-6666-8666-666666666666';
const ELECTRIC_METER_ID = '77777777-7777-7777-8777-777777777777';
const READING_WATER_ID = '88888888-8888-8888-8888-888888888888';
const READING_ELECTRIC_ID = 'aaaaaaaa-aaaa-aaaa-8aaa-aaaaaaaaaaaa';
const PROPERTY_ID = 'bbbbbbbb-bbbb-bbbb-8bbb-bbbbbbbbbbbb';

/** Minimal Decimal-shape mock — `toString()` is all the service consumes. */
const dec = (s: string) => ({ toString: () => s });

describe('InvoiceService', () => {
  let service: InstanceType<typeof InvoiceService>;
  let promptPay: InstanceType<typeof PromptPayService>;
  let notification: FakeNotificationService;
  // Untyped `MockInstance` — `vi.spyOn`'s generic constraint
  // (`MethodKeysOf<T>`) doesn't resolve cleanly against a class loaded via
  // `await import()`, so we use the default `Procedure` signature here. All
  // assertions go through `expect(...)` matchers which don't care about the
  // call signature.
  let buildPayloadSpy: MockInstance;

  beforeEach(() => {
    mockInvoiceFindMany.mockReset();
    mockInvoiceFindUnique.mockReset();
    mockInvoiceFindFirst.mockReset();
    mockInvoiceCreate.mockReset();
    mockInvoiceUpdate.mockReset();
    mockContractFindUnique.mockReset();
    mockContractFindMany.mockReset();
    mockMeterFindMany.mockReset();
    mockReadingFindMany.mockReset();
    mockCompanyFindUnique.mockReset();
    mockGetTenantContext.mockReset();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });

    promptPay = new PromptPayService();
    buildPayloadSpy = vi
      .spyOn(promptPay, 'buildPayload')
      .mockReturnValue(
        '00020101021129370016A000000677010111011300066123456789020253037645802TH540510.0063041234',
      );
    notification = new FakeNotificationService();
    // biome-ignore lint/suspicious/noExplicitAny: structural typing across test boundary
    service = new InvoiceService(promptPay, notification as any);
  });

  // ===================================================================
  // Read paths
  // ===================================================================

  describe('list', () => {
    it('queries with take=limit+1, items eager-loaded, ordered desc', async () => {
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      await service.list({ limit: 20 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockInvoiceFindMany.mock.calls[0]![0];
      expect(args.take).toBe(21);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.where).toEqual({});
      expect(args.include).toEqual({ items: { orderBy: { sortOrder: 'asc' } } });
    });

    it('AND-combines status + period + tenantId filters', async () => {
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      await service.list({
        status: 'issued',
        period: '2026-04',
        tenantId: TENANT_ID,
        limit: 10,
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockInvoiceFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({
        status: 'issued',
        period: '2026-04',
        tenantId: TENANT_ID,
      });
    });

    it('combines filters with cursor keyset under AND', async () => {
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: '2026-04-15T00:00:00.000Z', id: INVOICE_ID }),
        'utf8',
      ).toString('base64url');

      await service.list({ cursor, status: 'draft', limit: 10 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockInvoiceFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({
        AND: [
          { status: 'draft' },
          {
            OR: [
              { createdAt: { lt: new Date('2026-04-15T00:00:00.000Z') } },
              { createdAt: new Date('2026-04-15T00:00:00.000Z'), id: { lt: INVOICE_ID } },
            ],
          },
        ],
      });
    });
  });

  describe('getById', () => {
    it('returns row with items on hit', async () => {
      const row = { id: INVOICE_ID, items: [] };
      mockInvoiceFindUnique.mockResolvedValueOnce(row);
      await expect(service.getById(INVOICE_ID)).resolves.toBe(row);
      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockInvoiceFindUnique.mock.calls[0]![0];
      expect(args.include).toEqual({ items: { orderBy: { sortOrder: 'asc' } } });
    });

    it('throws NotFoundException on miss', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce(null);
      await expect(service.getById(INVOICE_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getByIdForTenant — LIFF /me/invoices/:id scope', () => {
    it('queries with both id AND tenantId', async () => {
      const row = { id: INVOICE_ID, tenantId: TENANT_ID, status: 'issued', items: [] };
      mockInvoiceFindFirst.mockResolvedValueOnce(row);

      await expect(service.getByIdForTenant(INVOICE_ID, TENANT_ID)).resolves.toBe(row);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockInvoiceFindFirst.mock.calls[0]![0];
      expect(args.where).toEqual({ id: INVOICE_ID, tenantId: TENANT_ID });
      expect(args.include).toEqual({ items: { orderBy: { sortOrder: 'asc' } } });
    });

    it('throws NotFoundException when invoice belongs to a different tenant (not 403 — no leak)', async () => {
      // Cross-tenant probe: same-company sibling asks for someone else's invoice id.
      // The (id, tenantId) WHERE clause filters it out → findFirst returns null → 404.
      mockInvoiceFindFirst.mockResolvedValueOnce(null);
      await expect(service.getByIdForTenant(INVOICE_ID, TENANT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when invoice id does not exist at all', async () => {
      mockInvoiceFindFirst.mockResolvedValueOnce(null);
      await expect(service.getByIdForTenant(INVOICE_ID, TENANT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when invoice status is draft (admin-only state)', async () => {
      // Tenant guesses / holds URL of a draft row → same 404 as if it didn't
      // exist. NEVER 403 (no leak of "this id is real but hidden").
      mockInvoiceFindFirst.mockResolvedValueOnce({
        id: INVOICE_ID,
        tenantId: TENANT_ID,
        status: 'draft',
        items: [],
      });
      await expect(service.getByIdForTenant(INVOICE_ID, TENANT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when invoice status is void', async () => {
      // Voided invoice no longer obligates the tenant — shouldn't surface.
      mockInvoiceFindFirst.mockResolvedValueOnce({
        id: INVOICE_ID,
        tenantId: TENANT_ID,
        status: 'void',
        items: [],
      });
      await expect(service.getByIdForTenant(INVOICE_ID, TENANT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each(['issued', 'partially_paid', 'paid'] as const)(
      'resolves when invoice status is %s (visible to tenant)',
      async (status) => {
        const row = { id: INVOICE_ID, tenantId: TENANT_ID, status, items: [] };
        mockInvoiceFindFirst.mockResolvedValueOnce(row);
        await expect(service.getByIdForTenant(INVOICE_ID, TENANT_ID)).resolves.toBe(row);
      },
    );
  });

  describe('listForTenant — LIFF /me/invoices scope', () => {
    it('pins tenantId from caller AND excludes draft + void by default', async () => {
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      await service.listForTenant({ limit: 20 }, TENANT_ID);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockInvoiceFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({
        tenantId: TENANT_ID,
        status: { notIn: ['draft', 'void'] },
      });
      expect(args.take).toBe(21);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.include).toEqual({ items: { orderBy: { sortOrder: 'asc' } } });
    });

    it('narrows to a specific visible status when caller provides one', async () => {
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      await service.listForTenant({ status: 'issued', limit: 20 }, TENANT_ID);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockInvoiceFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({ tenantId: TENANT_ID, status: 'issued' });
    });

    it.each(['draft', 'void'] as const)(
      'returns an empty page when caller requests hidden status "%s" (no leak, no DB round-trip)',
      async (hidden) => {
        const result = await service.listForTenant({ status: hidden, limit: 20 }, TENANT_ID);

        expect(result).toEqual({ items: [], nextCursor: null });
        // Early-return guard — no DB hit on hidden-status probes.
        expect(mockInvoiceFindMany).not.toHaveBeenCalled();
      },
    );

    it('honours period filter alongside default visibility exclusion', async () => {
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      await service.listForTenant({ period: '2026-04', limit: 20 }, TENANT_ID);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockInvoiceFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({
        tenantId: TENANT_ID,
        status: { notIn: ['draft', 'void'] },
        period: '2026-04',
      });
    });

    it('combines filters with cursor keyset under AND', async () => {
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: '2026-04-15T00:00:00.000Z', id: INVOICE_ID }),
        'utf8',
      ).toString('base64url');

      await service.listForTenant({ cursor, status: 'paid', limit: 10 }, TENANT_ID);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockInvoiceFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({
        AND: [
          { tenantId: TENANT_ID, status: 'paid' },
          {
            OR: [
              { createdAt: { lt: new Date('2026-04-15T00:00:00.000Z') } },
              { createdAt: new Date('2026-04-15T00:00:00.000Z'), id: { lt: INVOICE_ID } },
            ],
          },
        ],
      });
    });
  });

  // ===================================================================
  // create — single one-off invoice
  // ===================================================================

  describe('create', () => {
    const baseInput = {
      contractId: CONTRACT_ID,
      period: '2026-04' as const,
      dueDate: '2026-05-05T00:00:00.000Z',
      items: [
        {
          kind: 'rent' as const,
          description: 'ค่าเช่าห้อง 101 (2026-04)',
          quantity: '1.00',
          unitPrice: '4500.0000',
        },
        {
          kind: 'common_fee' as const,
          description: 'ค่าส่วนกลาง',
          quantity: '1.00',
          unitPrice: '300.0000',
        },
      ],
    };

    it('throws 500 when tenant context is missing', async () => {
      mockGetTenantContext.mockReturnValueOnce(undefined);
      await expect(service.create(baseInput)).rejects.toThrow(InternalServerErrorException);
    });

    it('rejects foreign contractId with 400 (RLS hides → findUnique null)', async () => {
      mockContractFindUnique.mockResolvedValueOnce(null);
      await expect(
        service.create({ ...baseInput, contractId: FOREIGN_CONTRACT_ID }),
      ).rejects.toThrow(BadRequestException);
      expect(mockInvoiceCreate).not.toHaveBeenCalled();
    });

    it('computes lineTotal + subtotal with decimal.js precision and stamps companyId', async () => {
      mockContractFindUnique.mockResolvedValueOnce({
        id: CONTRACT_ID,
        unitId: UNIT_ID,
        tenantId: TENANT_ID,
      });
      mockInvoiceCreate.mockResolvedValueOnce({ id: INVOICE_ID, items: [] });

      await service.create(baseInput);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockInvoiceCreate.mock.calls[0]![0];
      expect(args.data.companyId).toBe(COMPANY_ID);
      expect(args.data.contractId).toBe(CONTRACT_ID);
      expect(args.data.unitId).toBe(UNIT_ID);
      expect(args.data.tenantId).toBe(TENANT_ID);
      expect(args.data.period).toBe('2026-04');
      expect(args.data.status).toBe('draft');
      // 4500.0000 + 300.0000 = 4800.00
      expect(args.data.subtotal).toBe('4800.00');
      expect(args.data.total).toBe('4800.00');
      // Items nested-write — companyId stamped on every item too
      const items = args.data.items.create;
      expect(items).toHaveLength(2);
      expect(items[0].companyId).toBe(COMPANY_ID);
      expect(items[0].lineTotal).toBe('4500.00');
      expect(items[0].sortOrder).toBe(0);
      expect(items[1].companyId).toBe(COMPANY_ID);
      expect(items[1].lineTotal).toBe('300.00');
      expect(items[1].sortOrder).toBe(1);
    });

    it('does not introduce float drift (5.8124 × 123.45 = 717.541380 → 717.54)', async () => {
      mockContractFindUnique.mockResolvedValueOnce({
        id: CONTRACT_ID,
        unitId: UNIT_ID,
        tenantId: TENANT_ID,
      });
      mockInvoiceCreate.mockResolvedValueOnce({ id: INVOICE_ID, items: [] });

      await service.create({
        contractId: CONTRACT_ID,
        period: '2026-04',
        dueDate: '2026-05-05T00:00:00.000Z',
        items: [
          {
            kind: 'electric',
            description: 'ค่าไฟฟ้า',
            quantity: '123.45',
            unitPrice: '5.8124',
          },
        ],
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockInvoiceCreate.mock.calls[0]![0];
      expect(args.data.items.create[0].lineTotal).toBe('717.54');
      expect(args.data.subtotal).toBe('717.54');
    });

    it('translates P2002 on (contract_id, period) into 409 DuplicateInvoice', async () => {
      mockContractFindUnique.mockResolvedValueOnce({
        id: CONTRACT_ID,
        unitId: UNIT_ID,
        tenantId: TENANT_ID,
      });
      const p2002 = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['contract_id', 'period'] },
      });
      mockInvoiceCreate.mockRejectedValueOnce(p2002);

      await expect(service.create(baseInput)).rejects.toThrow(ConflictException);
    });

    it('rethrows non-P2002 Prisma errors untouched', async () => {
      mockContractFindUnique.mockResolvedValueOnce({
        id: CONTRACT_ID,
        unitId: UNIT_ID,
        tenantId: TENANT_ID,
      });
      mockInvoiceCreate.mockRejectedValueOnce(new Error('boom'));
      await expect(service.create(baseInput)).rejects.toThrow('boom');
    });
  });

  // ===================================================================
  // update — narrow PATCH (dueDate only, refuse status)
  // ===================================================================

  describe('update', () => {
    it('404s before any write when invoice is missing', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce(null);
      await expect(
        service.update(INVOICE_ID, { dueDate: '2026-05-10T00:00:00.000Z' }),
      ).rejects.toThrow(NotFoundException);
      expect(mockInvoiceUpdate).not.toHaveBeenCalled();
    });

    it('refuses status PATCH with 400 StatusNotPatchable', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({ id: INVOICE_ID, items: [] });
      await expect(service.update(INVOICE_ID, { status: 'issued' })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockInvoiceUpdate).not.toHaveBeenCalled();
    });

    it('forwards dueDate as a Date when provided', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({ id: INVOICE_ID, items: [] });
      mockInvoiceUpdate.mockResolvedValueOnce({ id: INVOICE_ID, items: [] });

      await service.update(INVOICE_ID, { dueDate: '2026-05-10T00:00:00.000Z' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockInvoiceUpdate.mock.calls[0]![0];
      expect(args.data.dueDate).toBeInstanceOf(Date);
      expect((args.data.dueDate as Date).toISOString()).toBe('2026-05-10T00:00:00.000Z');
    });

    it('omits dueDate from data when not in input (undefined → no-op)', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({ id: INVOICE_ID, items: [] });
      mockInvoiceUpdate.mockResolvedValueOnce({ id: INVOICE_ID, items: [] });

      await service.update(INVOICE_ID, {});

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockInvoiceUpdate.mock.calls[0]![0];
      expect(args.data).not.toHaveProperty('dueDate');
      expect(args.data).not.toHaveProperty('status');
    });
  });

  // ===================================================================
  // issue — state machine
  // ===================================================================

  describe('issue', () => {
    it('throws 500 when tenant context is missing', async () => {
      mockGetTenantContext.mockReturnValueOnce(undefined);
      await expect(service.issue(INVOICE_ID)).rejects.toThrow(InternalServerErrorException);
    });

    it('flips draft → issued, generates promptPayRef, refreshes issueDate', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'draft',
        total: '4800.00',
        items: [],
      });
      mockCompanyFindUnique.mockResolvedValueOnce({
        promptPayId: '0123456789',
        slug: 'easyslip',
      });
      // After Task #84, issue() reads tenantId/period/total/dueDate off the
      // returned row to enqueue the LINE notification — make sure the mock
      // covers all those fields.
      mockInvoiceUpdate.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'issued',
        tenantId: TENANT_ID,
        period: '2026-04',
        total: { toString: () => '4800.00' },
        dueDate: new Date('2026-05-05T00:00:00Z'),
        items: [],
      });

      await service.issue(INVOICE_ID);

      expect(buildPayloadSpy).toHaveBeenCalledWith({
        promptPayId: '0123456789',
        amount: '4800.00',
      });
      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockInvoiceUpdate.mock.calls[0]![0];
      expect(args.data.status).toBe('issued');
      expect(args.data.issueDate).toBeInstanceOf(Date);
      expect(typeof args.data.promptPayRef).toBe('string');
      expect(args.data.promptPayRef.length).toBeGreaterThan(0);
    });

    it('enqueues an INVOICE_ISSUED LINE push after the DB update (Task #84)', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'draft',
        total: '4800.00',
        items: [],
      });
      mockCompanyFindUnique.mockResolvedValueOnce({
        promptPayId: '0123456789',
        slug: 'easyslip',
      });
      mockInvoiceUpdate.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'issued',
        tenantId: TENANT_ID,
        period: '2026-04',
        total: { toString: () => '4800.00' },
        // @db.Date in Prisma → midnight UTC; slice(0,10) → "2026-05-05".
        dueDate: new Date('2026-05-05T00:00:00Z'),
        items: [],
      });

      await service.issue(INVOICE_ID);

      expect(notification.enqueueInvoiceIssued).toHaveBeenCalledWith({
        companyId: COMPANY_ID,
        companySlug: 'easyslip',
        tenantId: TENANT_ID,
        invoiceId: INVOICE_ID,
        period: '2026-04',
        totalAmount: '4800.00',
        dueDate: '2026-05-05',
      });
    });

    it('does NOT enqueue a notification on idempotent re-issue (already issued)', async () => {
      // Path: status === 'issued' short-circuits to return existing → never
      // reaches the notification call. Without this guard, every retry would
      // double-push.
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'issued',
        promptPayRef: 'EXISTING_QR',
        items: [],
      });

      await service.issue(INVOICE_ID);

      expect(notification.enqueueInvoiceIssued).not.toHaveBeenCalled();
    });

    it('does NOT enqueue a notification when PromptPay is not configured', async () => {
      // Path: throws before the DB update → no enqueue. Important because
      // a notification for an invoice that didn't actually issue would
      // surface a non-payable QR-less bill in the tenant's chat.
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'draft',
        total: '4800.00',
        items: [],
      });
      mockCompanyFindUnique.mockResolvedValueOnce({ promptPayId: null, slug: 'easyslip' });

      await expect(service.issue(INVOICE_ID)).rejects.toThrow(BadRequestException);

      expect(notification.enqueueInvoiceIssued).not.toHaveBeenCalled();
    });

    it('is idempotent on already-issued (no DB update, no QR regen)', async () => {
      const existing = {
        id: INVOICE_ID,
        status: 'issued',
        promptPayRef: 'ORIGINAL_QR_PAYLOAD',
        items: [],
      };
      mockInvoiceFindUnique.mockResolvedValueOnce(existing);

      const result = await service.issue(INVOICE_ID);

      expect(result).toBe(existing);
      expect(buildPayloadSpy).not.toHaveBeenCalled();
      expect(mockInvoiceUpdate).not.toHaveBeenCalled();
    });

    it('refuses paid → issue with 409 InvoiceNotDraft', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'paid',
        items: [],
      });
      await expect(service.issue(INVOICE_ID)).rejects.toThrow(ConflictException);
    });

    it('refuses void → issue with 409 InvoiceNotDraft', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'void',
        items: [],
      });
      await expect(service.issue(INVOICE_ID)).rejects.toThrow(ConflictException);
    });

    it('refuses partially_paid → issue with 409 InvoiceNotDraft', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'partially_paid',
        items: [],
      });
      await expect(service.issue(INVOICE_ID)).rejects.toThrow(ConflictException);
    });

    it('throws 400 PromptPayNotConfigured when company has no promptPayId', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'draft',
        total: '4800.00',
        items: [],
      });
      mockCompanyFindUnique.mockResolvedValueOnce({ promptPayId: null });

      await expect(service.issue(INVOICE_ID)).rejects.toThrow(BadRequestException);
      expect(mockInvoiceUpdate).not.toHaveBeenCalled();
    });
  });

  // ===================================================================
  // void — state machine
  // ===================================================================

  describe('void', () => {
    it('flips draft → void', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'draft',
        items: [],
      });
      mockInvoiceUpdate.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'void',
        items: [],
      });

      await service.void(INVOICE_ID, 'duplicate booking');

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockInvoiceUpdate.mock.calls[0]![0];
      expect(args.data).toEqual({ status: 'void' });
    });

    it('flips issued → void', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'issued',
        items: [],
      });
      mockInvoiceUpdate.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'void',
        items: [],
      });
      await service.void(INVOICE_ID, 'tenant moved out early');
      expect(mockInvoiceUpdate).toHaveBeenCalled();
    });

    it('flips partially_paid → void', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'partially_paid',
        items: [],
      });
      mockInvoiceUpdate.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'void',
        items: [],
      });
      await service.void(INVOICE_ID, 'reissue with corrected amount');
      expect(mockInvoiceUpdate).toHaveBeenCalled();
    });

    it('is idempotent on already-void (no DB update)', async () => {
      const existing = { id: INVOICE_ID, status: 'void', items: [] };
      mockInvoiceFindUnique.mockResolvedValueOnce(existing);

      const result = await service.void(INVOICE_ID, 'retry from flaky network');

      expect(result).toBe(existing);
      expect(mockInvoiceUpdate).not.toHaveBeenCalled();
    });

    it('refuses paid → void with 409 InvoicePaid', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        status: 'paid',
        items: [],
      });
      await expect(service.void(INVOICE_ID, 'oops')).rejects.toThrow(ConflictException);
      expect(mockInvoiceUpdate).not.toHaveBeenCalled();
    });
  });

  // ===================================================================
  // createBatch — two-phase plan + apply
  // ===================================================================

  describe('createBatch', () => {
    const baseInput = {
      period: '2026-04' as const,
      dueDayOfMonth: 5,
    };

    it('throws 500 when tenant context is missing', async () => {
      mockGetTenantContext.mockReturnValueOnce(undefined);
      await expect(service.createBatch(baseInput)).rejects.toThrow(InternalServerErrorException);
    });

    it('returns empty result when no contracts found', async () => {
      mockContractFindMany.mockResolvedValueOnce([]);
      const result = await service.createBatch(baseInput);
      expect(result).toEqual({ generatedInvoiceIds: [], skipped: [] });
      expect(mockInvoiceCreate).not.toHaveBeenCalled();
    });

    it('skips inactive_contract', async () => {
      mockContractFindMany.mockResolvedValueOnce([
        {
          id: CONTRACT_ID,
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          rentAmount: dec('4500.00'),
          status: 'ended',
          unit: { unitNumber: '101' },
        },
      ]);
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      mockMeterFindMany.mockResolvedValueOnce([]);
      mockReadingFindMany.mockResolvedValueOnce([]);

      const result = await service.createBatch(baseInput);

      expect(result.generatedInvoiceIds).toEqual([]);
      expect(result.skipped).toEqual([
        { unitId: UNIT_ID, contractId: CONTRACT_ID, reason: 'inactive_contract' },
      ]);
      expect(mockInvoiceCreate).not.toHaveBeenCalled();
    });

    it('skips duplicate_invoice when (contractId, period) already exists', async () => {
      mockContractFindMany.mockResolvedValueOnce([
        {
          id: CONTRACT_ID,
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          rentAmount: dec('4500.00'),
          status: 'active',
          unit: { unitNumber: '101' },
        },
      ]);
      mockInvoiceFindMany.mockResolvedValueOnce([{ contractId: CONTRACT_ID }]);
      mockMeterFindMany.mockResolvedValueOnce([]);
      mockReadingFindMany.mockResolvedValueOnce([]);

      const result = await service.createBatch(baseInput);

      expect(result.skipped).toEqual([
        { unitId: UNIT_ID, contractId: CONTRACT_ID, reason: 'duplicate_invoice' },
      ]);
      expect(mockInvoiceCreate).not.toHaveBeenCalled();

      // The duplicate-existence pre-check MUST exclude voided invoices —
      // voiding shouldn't burn the (contract, period) slot. Mirrors the
      // partial unique index in the migration.
      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const findManyArgs = mockInvoiceFindMany.mock.calls[0]![0];
      expect(findManyArgs.where).toEqual({
        contractId: { in: [CONTRACT_ID] },
        period: '2026-04',
        status: { not: 'void' },
      });
    });

    it('does NOT skip duplicate_invoice when only voided invoices exist for (contractId, period)', async () => {
      // After void, admin must be able to regenerate. The pre-check filters
      // out voided rows, so `existingInvoices` is empty → contract proceeds
      // to insert. A real DB will accept the insert because the partial
      // unique index excludes void.
      mockContractFindMany.mockResolvedValueOnce([
        {
          id: CONTRACT_ID,
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          rentAmount: dec('4500.00'),
          status: 'active',
          unit: { unitNumber: '101' },
        },
      ]);
      // Mock the post-filter result: API queried with `status: { not: 'void' }`
      // → DB returned no rows because the only existing invoice was voided.
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      mockMeterFindMany.mockResolvedValueOnce([]);
      mockReadingFindMany.mockResolvedValueOnce([]);
      mockInvoiceCreate.mockResolvedValueOnce({ id: INVOICE_ID });

      const result = await service.createBatch(baseInput);

      expect(result.generatedInvoiceIds).toEqual([INVOICE_ID]);
      expect(result.skipped).toEqual([]);
      expect(mockInvoiceCreate).toHaveBeenCalledTimes(1);
    });

    it('skips missing_water_reading when water meter exists but reading missing', async () => {
      mockContractFindMany.mockResolvedValueOnce([
        {
          id: CONTRACT_ID,
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          rentAmount: dec('4500.00'),
          status: 'active',
          unit: { unitNumber: '101' },
        },
      ]);
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      mockMeterFindMany.mockResolvedValueOnce([
        {
          id: WATER_METER_ID,
          unitId: UNIT_ID,
          kind: 'water',
          ratePerUnit: dec('18.0000'),
          unitOfMeasure: 'm³',
        },
      ]);
      mockReadingFindMany.mockResolvedValueOnce([]); // no readings at all

      const result = await service.createBatch(baseInput);

      expect(result.skipped).toEqual([
        { unitId: UNIT_ID, contractId: CONTRACT_ID, reason: 'missing_water_reading' },
      ]);
      expect(mockInvoiceCreate).not.toHaveBeenCalled();
    });

    it('skips missing_electric_reading when water OK but electric missing', async () => {
      mockContractFindMany.mockResolvedValueOnce([
        {
          id: CONTRACT_ID,
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          rentAmount: dec('4500.00'),
          status: 'active',
          unit: { unitNumber: '101' },
        },
      ]);
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      mockMeterFindMany.mockResolvedValueOnce([
        {
          id: WATER_METER_ID,
          unitId: UNIT_ID,
          kind: 'water',
          ratePerUnit: dec('18.0000'),
          unitOfMeasure: 'm³',
        },
        {
          id: ELECTRIC_METER_ID,
          unitId: UNIT_ID,
          kind: 'electric',
          ratePerUnit: dec('5.8124'),
          unitOfMeasure: 'kWh',
        },
      ]);
      mockReadingFindMany.mockResolvedValueOnce([
        { id: READING_WATER_ID, meterId: WATER_METER_ID, consumption: dec('5.50') },
      ]);

      const result = await service.createBatch(baseInput);

      expect(result.skipped).toEqual([
        { unitId: UNIT_ID, contractId: CONTRACT_ID, reason: 'missing_electric_reading' },
      ]);
      expect(mockInvoiceCreate).not.toHaveBeenCalled();
    });

    it('happy path: composes rent + water + electric, stamps companyId', async () => {
      mockContractFindMany.mockResolvedValueOnce([
        {
          id: CONTRACT_ID,
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          rentAmount: dec('4500.00'),
          status: 'active',
          unit: { unitNumber: '101' },
        },
      ]);
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      mockMeterFindMany.mockResolvedValueOnce([
        {
          id: WATER_METER_ID,
          unitId: UNIT_ID,
          kind: 'water',
          ratePerUnit: dec('18.0000'),
          unitOfMeasure: 'm³',
        },
        {
          id: ELECTRIC_METER_ID,
          unitId: UNIT_ID,
          kind: 'electric',
          ratePerUnit: dec('5.8124'),
          unitOfMeasure: 'kWh',
        },
      ]);
      mockReadingFindMany.mockResolvedValueOnce([
        { id: READING_WATER_ID, meterId: WATER_METER_ID, consumption: dec('5.50') },
        { id: READING_ELECTRIC_ID, meterId: ELECTRIC_METER_ID, consumption: dec('123.45') },
      ]);
      mockInvoiceCreate.mockResolvedValueOnce({ id: INVOICE_ID });

      const result = await service.createBatch(baseInput);

      expect(result.generatedInvoiceIds).toEqual([INVOICE_ID]);
      expect(result.skipped).toEqual([]);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockInvoiceCreate.mock.calls[0]![0];
      expect(args.data.companyId).toBe(COMPANY_ID);
      expect(args.data.contractId).toBe(CONTRACT_ID);
      expect(args.data.unitId).toBe(UNIT_ID);
      expect(args.data.tenantId).toBe(TENANT_ID);
      expect(args.data.period).toBe('2026-04');
      expect(args.data.status).toBe('draft');
      expect(args.data.dueDate).toBeInstanceOf(Date);

      const items = args.data.items.create;
      // 3 items: rent, water, electric
      expect(items).toHaveLength(3);
      expect(items[0].kind).toBe('rent');
      expect(items[0].lineTotal).toBe('4500.00');
      expect(items[0].sortOrder).toBe(0);
      expect(items[0].readingId).toBeNull();
      expect(items[0].companyId).toBe(COMPANY_ID);

      expect(items[1].kind).toBe('water');
      // 5.50 × 18.0000 = 99.00
      expect(items[1].lineTotal).toBe('99.00');
      expect(items[1].readingId).toBe(READING_WATER_ID);
      expect(items[1].sortOrder).toBe(1);

      expect(items[2].kind).toBe('electric');
      // 123.45 × 5.8124 = 717.541380 → 717.54
      expect(items[2].lineTotal).toBe('717.54');
      expect(items[2].readingId).toBe(READING_ELECTRIC_ID);
      expect(items[2].sortOrder).toBe(2);

      // subtotal = 4500.00 + 99.00 + 717.54 = 5316.54
      expect(args.data.subtotal).toBe('5316.54');
      expect(args.data.total).toBe('5316.54');
    });

    it('appends additionalItems in caller order after rent/utility lines', async () => {
      mockContractFindMany.mockResolvedValueOnce([
        {
          id: CONTRACT_ID,
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          rentAmount: dec('4500.00'),
          status: 'active',
          unit: { unitNumber: '101' },
        },
      ]);
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      mockMeterFindMany.mockResolvedValueOnce([]); // no meters → no utility lines
      mockReadingFindMany.mockResolvedValueOnce([]);
      mockInvoiceCreate.mockResolvedValueOnce({ id: INVOICE_ID });

      await service.createBatch({
        ...baseInput,
        additionalItems: [
          {
            kind: 'common_fee',
            description: 'ค่าส่วนกลาง',
            quantity: '1.00',
            unitPrice: '300.0000',
          },
          {
            kind: 'other',
            description: 'ค่าจอดรถ',
            quantity: '1.00',
            unitPrice: '500.0000',
          },
        ],
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockInvoiceCreate.mock.calls[0]![0];
      const items = args.data.items.create;
      // rent + 2 additional
      expect(items).toHaveLength(3);
      expect(items[0].kind).toBe('rent');
      expect(items[1].kind).toBe('common_fee');
      expect(items[1].sortOrder).toBe(1);
      expect(items[2].kind).toBe('other');
      expect(items[2].sortOrder).toBe(2);
      // subtotal = 4500.00 + 300.00 + 500.00 = 5300.00
      expect(args.data.subtotal).toBe('5300.00');
    });

    it('handles race-window P2002 by skipping (not throwing) — keeps batch resilient', async () => {
      mockContractFindMany.mockResolvedValueOnce([
        {
          id: CONTRACT_ID,
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          rentAmount: dec('4500.00'),
          status: 'active',
          unit: { unitNumber: '101' },
        },
      ]);
      mockInvoiceFindMany.mockResolvedValueOnce([]); // pre-check OK
      mockMeterFindMany.mockResolvedValueOnce([]);
      mockReadingFindMany.mockResolvedValueOnce([]);

      // But by the time we INSERT, a concurrent batch wrote the row first.
      const p2002 = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['contract_id', 'period'] },
      });
      mockInvoiceCreate.mockRejectedValueOnce(p2002);

      const result = await service.createBatch(baseInput);

      expect(result.generatedInvoiceIds).toEqual([]);
      expect(result.skipped).toEqual([
        { unitId: UNIT_ID, contractId: CONTRACT_ID, reason: 'duplicate_invoice' },
      ]);
    });

    it("rethrows non-P2002 Prisma errors during apply (don't swallow real bugs)", async () => {
      mockContractFindMany.mockResolvedValueOnce([
        {
          id: CONTRACT_ID,
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          rentAmount: dec('4500.00'),
          status: 'active',
          unit: { unitNumber: '101' },
        },
      ]);
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      mockMeterFindMany.mockResolvedValueOnce([]);
      mockReadingFindMany.mockResolvedValueOnce([]);
      mockInvoiceCreate.mockRejectedValueOnce(new Error('connection lost'));

      await expect(service.createBatch(baseInput)).rejects.toThrow('connection lost');
    });

    it('processes mixed batch — one generated, one skipped', async () => {
      const CONTRACT_ID_2 = 'cccccccc-cccc-cccc-8ccc-cccccccccccc';
      const UNIT_ID_2 = 'dddddddd-dddd-dddd-8ddd-dddddddddddd';

      mockContractFindMany.mockResolvedValueOnce([
        {
          id: CONTRACT_ID,
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          rentAmount: dec('4500.00'),
          status: 'active',
          unit: { unitNumber: '101' },
        },
        {
          id: CONTRACT_ID_2,
          unitId: UNIT_ID_2,
          tenantId: TENANT_ID,
          rentAmount: dec('5000.00'),
          status: 'ended', // → skip inactive_contract
          unit: { unitNumber: '102' },
        },
      ]);
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      mockMeterFindMany.mockResolvedValueOnce([]); // no meters anywhere
      mockReadingFindMany.mockResolvedValueOnce([]);
      mockInvoiceCreate.mockResolvedValueOnce({ id: INVOICE_ID });

      const result = await service.createBatch(baseInput);

      expect(result.generatedInvoiceIds).toEqual([INVOICE_ID]);
      expect(result.skipped).toEqual([
        { unitId: UNIT_ID_2, contractId: CONTRACT_ID_2, reason: 'inactive_contract' },
      ]);
    });

    it('passes propertyId filter through to contract.findMany via unit relation', async () => {
      mockContractFindMany.mockResolvedValueOnce([]);
      await service.createBatch({ ...baseInput, propertyId: PROPERTY_ID });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockContractFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({ unit: { propertyId: PROPERTY_ID } });
    });

    it('computes dueDate as day-N of NEXT period in Bangkok local (period 2026-04 + day 5 → 2026-05-05 in TH)', async () => {
      mockContractFindMany.mockResolvedValueOnce([
        {
          id: CONTRACT_ID,
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          rentAmount: dec('4500.00'),
          status: 'active',
          unit: { unitNumber: '101' },
        },
      ]);
      mockInvoiceFindMany.mockResolvedValueOnce([]);
      mockMeterFindMany.mockResolvedValueOnce([]);
      mockReadingFindMany.mockResolvedValueOnce([]);
      mockInvoiceCreate.mockResolvedValueOnce({ id: INVOICE_ID });

      await service.createBatch({ period: '2026-04', dueDayOfMonth: 5 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockInvoiceCreate.mock.calls[0]![0];
      const due = args.data.dueDate as Date;
      // 2026-05-05 00:00 Asia/Bangkok = 2026-05-04 17:00 UTC
      expect(due.toISOString()).toBe('2026-05-04T17:00:00.000Z');
    });
  });
});
