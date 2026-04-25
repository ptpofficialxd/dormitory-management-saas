import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for PaymentService — mocks `@dorm/db` to keep the suite DB-free.
 *
 * Coverage focus:
 *   - companyId stamping from tenant context on INSERT
 *   - Cross-tenant FK guard: invoiceId pre-check rejects foreign / draft /
 *     void invoices
 *   - tenantId NOT trusted from caller — sourced from invoice
 *   - Idempotency: P2002 on (company_id, idempotency_key) → return existing
 *     row (200), NOT throw
 *   - SAVEPOINT recovery: $executeRawUnsafe SAVEPOINT/ROLLBACK/RELEASE wraps
 *     the INSERT so a concurrent collision doesn't abort the outer request tx
 *   - State machine — confirm:
 *       pending → confirmed (happy + invoice rollup runs against same prisma)
 *       confirmed → confirmed (idempotent no-op)
 *       rejected → confirm → 409 PaymentAlreadyRejected
 *   - State machine — reject:
 *       pending → rejected (happy)
 *       rejected → rejected (idempotent no-op)
 *       confirmed → reject → 409 PaymentAlreadyConfirmed
 *   - Invoice rollup math:
 *       paid_total >= invoice.total → invoice.status = 'paid'
 *       0 < paid_total < total      → invoice.status = 'partially_paid'
 *       void invoices skipped
 *
 * NOTE: confirm() / reject() / recomputeInvoiceStatus() use the `prisma` Proxy
 * directly. The OUTER `withTenant()` tx (opened by TenantContextInterceptor at
 * the request boundary) is what gives them atomicity — there is NO nested
 * `prisma.$transaction()` call here. Tests therefore mock `prisma.payment.*`
 * and `prisma.invoice.*` (NOT a tx-callback shape).
 *
 * RLS cross-company isolation is asserted in the e2e suite (Postgres-only).
 */

const mockPaymentFindMany = vi.fn();
const mockPaymentFindUnique = vi.fn();
const mockPaymentFindFirst = vi.fn();
const mockPaymentCreate = vi.fn();
const mockPaymentUpdate = vi.fn();
const mockInvoiceFindUnique = vi.fn();
const mockInvoiceFindFirst = vi.fn();
const mockInvoiceUpdate = vi.fn();
const mockCompanyFindUnique = vi.fn();
const mockExecuteRawUnsafe = vi.fn();
const mockGetTenantContext = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    payment: {
      findMany: mockPaymentFindMany,
      findUnique: mockPaymentFindUnique,
      findFirst: mockPaymentFindFirst,
      create: mockPaymentCreate,
      update: mockPaymentUpdate,
    },
    invoice: {
      findUnique: mockInvoiceFindUnique,
      findFirst: mockInvoiceFindFirst,
      update: mockInvoiceUpdate,
    },
    company: {
      findUnique: mockCompanyFindUnique,
    },
    $executeRawUnsafe: mockExecuteRawUnsafe,
  },
  getTenantContext: mockGetTenantContext,
  Prisma: {},
}));

const { PaymentService } = await import('./payment.service.js');

/**
 * Stand-in for `NotificationService` (Task #84). Confirm + reject paths now
 * call enqueuePaymentApproved / enqueuePaymentRejected after the DB update.
 * The mock just resolves — producer-side errors are swallowed by the real
 * impl, so we only need to assert the call shape.
 */
class FakeNotificationService {
  enqueueInvoiceIssued = vi.fn().mockResolvedValue(undefined);
  enqueuePaymentApproved = vi.fn().mockResolvedValue(undefined);
  enqueuePaymentRejected = vi.fn().mockResolvedValue(undefined);
}

const COMPANY_ID = '11111111-1111-1111-8111-111111111111';
const INVOICE_ID = '22222222-2222-2222-8222-222222222222';
const FOREIGN_INVOICE_ID = '99999999-9999-9999-8999-999999999999';
const TENANT_ID = '33333333-3333-3333-8333-333333333333';
const PAYMENT_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_USER_ID = '55555555-5555-5555-8555-555555555555';
const IDEMPOTENCY_KEY = '01HNV4YGZJK5TX1Z3F8H9ABCDEF';

/** Minimal Decimal-shape mock — `toString()` is all the service consumes. */
const dec = (s: string) => ({ toString: () => s });

describe('PaymentService', () => {
  let service: InstanceType<typeof PaymentService>;
  let notification: FakeNotificationService;

  beforeEach(() => {
    mockPaymentFindMany.mockReset();
    mockPaymentFindUnique.mockReset();
    mockPaymentFindFirst.mockReset();
    mockPaymentCreate.mockReset();
    mockPaymentUpdate.mockReset();
    mockInvoiceFindUnique.mockReset();
    mockInvoiceFindFirst.mockReset();
    mockInvoiceUpdate.mockReset();
    mockCompanyFindUnique.mockReset();
    mockExecuteRawUnsafe.mockReset();
    mockGetTenantContext.mockReset();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });
    // SAVEPOINT / RELEASE / ROLLBACK are no-ops at the mock layer — pgcrypto
    // and tx-state behaviour belong to the e2e suite.
    mockExecuteRawUnsafe.mockResolvedValue(0);
    // Default returns for the post-update enqueue path (Task #84). Tests
    // that mock the recompute step's invoice.findUnique with
    // mockResolvedValueOnce override the FIRST call; the SECOND call (from
    // enqueuePaymentNotification) falls through to this default. Existing
    // tests don't need to be updated unless they assert the enqueue itself.
    mockInvoiceFindUnique.mockResolvedValue({
      id: INVOICE_ID,
      period: '2026-04',
      tenantId: TENANT_ID,
    });
    mockCompanyFindUnique.mockResolvedValue({ slug: 'easyslip' });
    notification = new FakeNotificationService();
    // biome-ignore lint/suspicious/noExplicitAny: structural typing across test boundary
    service = new PaymentService(notification as any);
  });

  // ===================================================================
  // Read paths
  // ===================================================================

  describe('list', () => {
    it('queries with take=limit+1 + orderBy [createdAt desc, id desc]', async () => {
      mockPaymentFindMany.mockResolvedValueOnce([]);
      await service.list({ limit: 20 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockPaymentFindMany.mock.calls[0]![0];
      expect(args.take).toBe(21);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.where).toEqual({});
    });

    it('AND-combines status + invoiceId + tenantId filters', async () => {
      mockPaymentFindMany.mockResolvedValueOnce([]);
      await service.list({
        status: 'pending',
        invoiceId: INVOICE_ID,
        tenantId: TENANT_ID,
        limit: 10,
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockPaymentFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({
        status: 'pending',
        invoiceId: INVOICE_ID,
        tenantId: TENANT_ID,
      });
    });

    it('combines filters with cursor keyset under AND', async () => {
      mockPaymentFindMany.mockResolvedValueOnce([]);
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: '2026-04-15T00:00:00.000Z', id: PAYMENT_ID }),
        'utf8',
      ).toString('base64url');

      await service.list({ cursor, status: 'confirmed', limit: 10 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockPaymentFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({
        AND: [
          { status: 'confirmed' },
          {
            OR: [
              { createdAt: { lt: new Date('2026-04-15T00:00:00.000Z') } },
              { createdAt: new Date('2026-04-15T00:00:00.000Z'), id: { lt: PAYMENT_ID } },
            ],
          },
        ],
      });
    });
  });

  describe('getById', () => {
    it('returns row on hit', async () => {
      const row = { id: PAYMENT_ID, status: 'pending' };
      mockPaymentFindUnique.mockResolvedValueOnce(row);
      await expect(service.getById(PAYMENT_ID)).resolves.toBe(row);
    });

    it('throws NotFoundException on miss', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce(null);
      await expect(service.getById(PAYMENT_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getByIdForTenant — LIFF /me/payments/:id scope + slip ownership guard', () => {
    it('queries with both id AND tenantId', async () => {
      const row = { id: PAYMENT_ID, tenantId: TENANT_ID, status: 'pending' };
      mockPaymentFindFirst.mockResolvedValueOnce(row);

      await expect(service.getByIdForTenant(PAYMENT_ID, TENANT_ID)).resolves.toBe(row);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockPaymentFindFirst.mock.calls[0]![0];
      expect(args.where).toEqual({ id: PAYMENT_ID, tenantId: TENANT_ID });
    });

    it('throws 404 (not 403) on cross-tenant probe', async () => {
      mockPaymentFindFirst.mockResolvedValueOnce(null);
      await expect(service.getByIdForTenant(PAYMENT_ID, TENANT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('createForTenant — invoice ownership pre-check', () => {
    const baseInput = {
      invoiceId: INVOICE_ID,
      amount: '4800.00',
      method: 'promptpay' as const,
    };

    it('rejects when invoice does not belong to caller', async () => {
      // Same-company sibling probe: caller is tenant A, invoice belongs to
      // tenant B in the same company. RLS lets the query through; the
      // explicit tenantId filter rejects it -> findFirst returns null ->
      // BadRequestException with InvalidInvoiceId.
      mockInvoiceFindFirst.mockResolvedValueOnce(null);
      await expect(service.createForTenant(baseInput, IDEMPOTENCY_KEY, TENANT_ID)).rejects.toThrow(
        BadRequestException,
      );
      // Underlying create() must NOT have been called.
      expect(mockPaymentCreate).not.toHaveBeenCalled();
    });
  });

  // ===================================================================
  // create — tenant context + FK guard + idempotency
  // ===================================================================

  describe('create', () => {
    const baseInput = {
      invoiceId: INVOICE_ID,
      amount: '4800.00',
      method: 'promptpay' as const,
    };

    it('throws 500 when tenant context is missing', async () => {
      mockGetTenantContext.mockReturnValueOnce(undefined);
      await expect(service.create(baseInput, IDEMPOTENCY_KEY)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('rejects foreign invoiceId with 400 (RLS hides → findUnique null)', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce(null);
      await expect(
        service.create({ ...baseInput, invoiceId: FOREIGN_INVOICE_ID }, IDEMPOTENCY_KEY),
      ).rejects.toThrow(BadRequestException);
      expect(mockPaymentCreate).not.toHaveBeenCalled();
    });

    it('rejects creating against draft invoice with 409 InvoiceNotIssued', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        tenantId: TENANT_ID,
        status: 'draft',
        total: dec('4800.00'),
      });
      await expect(service.create(baseInput, IDEMPOTENCY_KEY)).rejects.toThrow(ConflictException);
      expect(mockPaymentCreate).not.toHaveBeenCalled();
    });

    it('rejects creating against void invoice with 409 InvoiceVoid', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        tenantId: TENANT_ID,
        status: 'void',
        total: dec('4800.00'),
      });
      await expect(service.create(baseInput, IDEMPOTENCY_KEY)).rejects.toThrow(ConflictException);
      expect(mockPaymentCreate).not.toHaveBeenCalled();
    });

    it('rejects zero / negative amount with 400 InvalidAmount', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        tenantId: TENANT_ID,
        status: 'issued',
        total: dec('4800.00'),
      });
      await expect(
        service.create({ ...baseInput, amount: '0.00' }, IDEMPOTENCY_KEY),
      ).rejects.toThrow(BadRequestException);
      expect(mockPaymentCreate).not.toHaveBeenCalled();
    });

    it('happy path stamps companyId, sources tenantId from invoice, persists idempotencyKey', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        tenantId: TENANT_ID,
        status: 'issued',
        total: dec('4800.00'),
      });
      mockPaymentFindFirst.mockResolvedValueOnce(null); // no replay
      mockPaymentCreate.mockResolvedValueOnce({ id: PAYMENT_ID, status: 'pending' });

      await service.create(baseInput, IDEMPOTENCY_KEY);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockPaymentCreate.mock.calls[0]![0];
      expect(args.data.companyId).toBe(COMPANY_ID);
      expect(args.data.invoiceId).toBe(INVOICE_ID);
      expect(args.data.tenantId).toBe(TENANT_ID); // sourced from invoice, not caller
      expect(args.data.amount).toBe('4800.00');
      expect(args.data.method).toBe('promptpay');
      expect(args.data.status).toBe('pending');
      expect(args.data.paidAt).toBeNull();
      expect(args.data.idempotencyKey).toBe(IDEMPOTENCY_KEY);
      // SAVEPOINT + RELEASE on the happy path (no ROLLBACK).
      const stmts = mockExecuteRawUnsafe.mock.calls.map((c) => c[0] as string);
      expect(stmts).toEqual([
        'SAVEPOINT idempotent_payment_create',
        'RELEASE SAVEPOINT idempotent_payment_create',
      ]);
    });

    it('forwards optional paidAt as a Date when provided', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        tenantId: TENANT_ID,
        status: 'issued',
        total: dec('4800.00'),
      });
      mockPaymentFindFirst.mockResolvedValueOnce(null); // no replay
      mockPaymentCreate.mockResolvedValueOnce({ id: PAYMENT_ID });

      await service.create({ ...baseInput, paidAt: '2026-04-20T10:30:00.000Z' }, IDEMPOTENCY_KEY);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockPaymentCreate.mock.calls[0]![0];
      expect(args.data.paidAt).toBeInstanceOf(Date);
      expect((args.data.paidAt as Date).toISOString()).toBe('2026-04-20T10:30:00.000Z');
    });

    it('idempotency replay (pre-check): findFirst hit short-circuits BEFORE create()', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        tenantId: TENANT_ID,
        status: 'issued',
        total: dec('4800.00'),
      });
      const existing = { id: PAYMENT_ID, status: 'pending', idempotencyKey: IDEMPOTENCY_KEY };
      mockPaymentFindFirst.mockResolvedValueOnce(existing);

      const result = await service.create(baseInput, IDEMPOTENCY_KEY);

      expect(result).toBe(existing);
      expect(mockPaymentCreate).not.toHaveBeenCalled();
      expect(mockExecuteRawUnsafe).not.toHaveBeenCalled(); // savepoint never opened
      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const lookupArgs = mockPaymentFindFirst.mock.calls[0]![0];
      expect(lookupArgs.where).toEqual({ idempotencyKey: IDEMPOTENCY_KEY });
    });

    it('idempotency race (savepoint catch): P2002 → ROLLBACK + lookup returns existing row', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        tenantId: TENANT_ID,
        status: 'issued',
        total: dec('4800.00'),
      });
      mockPaymentFindFirst.mockResolvedValueOnce(null); // pre-check miss
      const p2002 = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['company_id', 'idempotency_key'] },
      });
      mockPaymentCreate.mockRejectedValueOnce(p2002);
      const existing = { id: PAYMENT_ID, status: 'pending', idempotencyKey: IDEMPOTENCY_KEY };
      mockPaymentFindFirst.mockResolvedValueOnce(existing); // post-rollback lookup

      const result = await service.create(baseInput, IDEMPOTENCY_KEY);

      expect(result).toBe(existing);
      // SAVEPOINT then ROLLBACK (no RELEASE on failure).
      const stmts = mockExecuteRawUnsafe.mock.calls.map((c) => c[0] as string);
      expect(stmts).toEqual([
        'SAVEPOINT idempotent_payment_create',
        'ROLLBACK TO SAVEPOINT idempotent_payment_create',
      ]);
    });

    it('rethrows non-P2002 Prisma errors after rolling back the savepoint', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        tenantId: TENANT_ID,
        status: 'issued',
        total: dec('4800.00'),
      });
      mockPaymentFindFirst.mockResolvedValueOnce(null); // pre-check miss
      mockPaymentCreate.mockRejectedValueOnce(new Error('boom'));
      await expect(service.create(baseInput, IDEMPOTENCY_KEY)).rejects.toThrow('boom');
      const stmts = mockExecuteRawUnsafe.mock.calls.map((c) => c[0] as string);
      // SAVEPOINT then ROLLBACK on the failure path so the outer tx survives.
      expect(stmts).toEqual([
        'SAVEPOINT idempotent_payment_create',
        'ROLLBACK TO SAVEPOINT idempotent_payment_create',
      ]);
    });
  });

  // ===================================================================
  // confirm — state machine + invoice rollup
  // ===================================================================

  describe('confirm', () => {
    it('flips pending → confirmed with confirmedByUserId stamped', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
        amount: dec('4800.00'),
      });
      mockPaymentUpdate.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'confirmed',
        invoiceId: INVOICE_ID,
      });
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        total: dec('4800.00'),
        status: 'issued',
      });
      mockPaymentFindMany.mockResolvedValueOnce([{ amount: dec('4800.00') }]);

      await service.confirm(PAYMENT_ID, ADMIN_USER_ID, 'looks legit');

      // payment.update assertions
      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const updArgs = mockPaymentUpdate.mock.calls[0]![0];
      expect(updArgs.where).toEqual({ id: PAYMENT_ID });
      expect(updArgs.data.status).toBe('confirmed');
      expect(updArgs.data.confirmedByUserId).toBe(ADMIN_USER_ID);
      expect(updArgs.data.confirmedAt).toBeInstanceOf(Date);
    });

    it('is idempotent on already-confirmed (no DB write, returns existing row)', async () => {
      const existing = { id: PAYMENT_ID, status: 'confirmed', invoiceId: INVOICE_ID };
      mockPaymentFindUnique.mockResolvedValueOnce(existing);

      const result = await service.confirm(PAYMENT_ID, ADMIN_USER_ID);

      expect(result).toBe(existing);
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
      expect(mockInvoiceUpdate).not.toHaveBeenCalled();
    });

    it('refuses rejected → confirm with 409 PaymentAlreadyRejected', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'rejected',
        invoiceId: INVOICE_ID,
      });
      await expect(service.confirm(PAYMENT_ID, ADMIN_USER_ID)).rejects.toThrow(ConflictException);
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
      expect(mockInvoiceUpdate).not.toHaveBeenCalled();
    });

    it('rollup: confirmed sum == total → invoice.status = paid', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
      });
      mockPaymentUpdate.mockResolvedValueOnce({ id: PAYMENT_ID, invoiceId: INVOICE_ID });
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        total: dec('4800.00'),
        status: 'issued',
      });
      mockPaymentFindMany.mockResolvedValueOnce([{ amount: dec('4800.00') }]);

      await service.confirm(PAYMENT_ID, ADMIN_USER_ID);

      // biome-ignore lint/style/noNonNullAssertion: rollup MUST run and update invoice
      const updArgs = mockInvoiceUpdate.mock.calls[0]![0];
      expect(updArgs.data.status).toBe('paid');
    });

    it('rollup: confirmed sum > total (overpayment) → invoice.status = paid', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
      });
      mockPaymentUpdate.mockResolvedValueOnce({ id: PAYMENT_ID, invoiceId: INVOICE_ID });
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        total: dec('4800.00'),
        status: 'issued',
      });
      mockPaymentFindMany.mockResolvedValueOnce([
        { amount: dec('4800.00') },
        { amount: dec('100.00') }, // overpayment
      ]);

      await service.confirm(PAYMENT_ID, ADMIN_USER_ID);

      // biome-ignore lint/style/noNonNullAssertion: rollup MUST mark fully paid
      const updArgs = mockInvoiceUpdate.mock.calls[0]![0];
      expect(updArgs.data.status).toBe('paid');
    });

    it('rollup: 0 < confirmed sum < total → invoice.status = partially_paid', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
      });
      mockPaymentUpdate.mockResolvedValueOnce({ id: PAYMENT_ID, invoiceId: INVOICE_ID });
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        total: dec('4800.00'),
        status: 'issued',
      });
      mockPaymentFindMany.mockResolvedValueOnce([{ amount: dec('2400.00') }]);

      await service.confirm(PAYMENT_ID, ADMIN_USER_ID);

      // biome-ignore lint/style/noNonNullAssertion: rollup MUST mark partial
      const updArgs = mockInvoiceUpdate.mock.calls[0]![0];
      expect(updArgs.data.status).toBe('partially_paid');
    });

    it('rollup: void invoice is skipped (no status flip)', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
      });
      mockPaymentUpdate.mockResolvedValueOnce({ id: PAYMENT_ID, invoiceId: INVOICE_ID });
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        total: dec('4800.00'),
        status: 'void',
      });

      await service.confirm(PAYMENT_ID, ADMIN_USER_ID);

      expect(mockPaymentFindMany).not.toHaveBeenCalled(); // short-circuited
      expect(mockInvoiceUpdate).not.toHaveBeenCalled();
    });

    it('rollup: skip when next status equals current (avoid no-op write + audit noise)', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
      });
      mockPaymentUpdate.mockResolvedValueOnce({ id: PAYMENT_ID, invoiceId: INVOICE_ID });
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        total: dec('4800.00'),
        status: 'partially_paid', // already partial
      });
      mockPaymentFindMany.mockResolvedValueOnce([{ amount: dec('2400.00') }]);

      await service.confirm(PAYMENT_ID, ADMIN_USER_ID);

      // computed = partially_paid, current = partially_paid → no write
      expect(mockInvoiceUpdate).not.toHaveBeenCalled();
    });

    it('enqueues PAYMENT_APPROVED LINE push after the DB update (Task #84)', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
      });
      mockPaymentUpdate.mockResolvedValueOnce({ id: PAYMENT_ID, invoiceId: INVOICE_ID });
      // Recompute step fetches invoice {total, status}; default mock for
      // the enqueue's second findUnique kicks in via mockResolvedValue
      // (period + tenantId).
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        total: dec('4800.00'),
        status: 'issued',
      });
      mockPaymentFindMany.mockResolvedValueOnce([{ amount: dec('4800.00') }]);

      await service.confirm(PAYMENT_ID, ADMIN_USER_ID);

      expect(notification.enqueuePaymentApproved).toHaveBeenCalledWith({
        companyId: COMPANY_ID,
        companySlug: 'easyslip',
        tenantId: TENANT_ID,
        invoiceId: INVOICE_ID,
        period: '2026-04',
      });
      expect(notification.enqueuePaymentRejected).not.toHaveBeenCalled();
    });

    it('does NOT enqueue on idempotent re-confirm (already confirmed)', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'confirmed',
        invoiceId: INVOICE_ID,
      });

      await service.confirm(PAYMENT_ID, ADMIN_USER_ID);

      expect(notification.enqueuePaymentApproved).not.toHaveBeenCalled();
    });
  });

  // ===================================================================
  // reject — state machine
  // ===================================================================

  describe('reject', () => {
    it('flips pending → rejected with rejectionReason persisted', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
      });
      mockPaymentUpdate.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'rejected',
      });

      await service.reject(PAYMENT_ID, 'slip amount mismatch');

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockPaymentUpdate.mock.calls[0]![0];
      expect(args.data).toEqual({ status: 'rejected', rejectionReason: 'slip amount mismatch' });
    });

    it('is idempotent on already-rejected (no DB update)', async () => {
      const existing = { id: PAYMENT_ID, status: 'rejected', invoiceId: INVOICE_ID };
      mockPaymentFindUnique.mockResolvedValueOnce(existing);

      const result = await service.reject(PAYMENT_ID, 'still bad');

      expect(result).toBe(existing);
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
    });

    it('refuses confirmed → reject with 409 PaymentAlreadyConfirmed', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'confirmed',
        invoiceId: INVOICE_ID,
      });
      await expect(service.reject(PAYMENT_ID, 'oops')).rejects.toThrow(ConflictException);
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
    });

    it('enqueues PAYMENT_REJECTED LINE push with the verbatim reason (Task #84)', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
      });
      mockPaymentUpdate.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'rejected',
        invoiceId: INVOICE_ID,
      });

      await service.reject(PAYMENT_ID, 'ยอดเงินในสลิปไม่ตรงกับใบแจ้งหนี้');

      expect(notification.enqueuePaymentRejected).toHaveBeenCalledWith({
        companyId: COMPANY_ID,
        companySlug: 'easyslip',
        tenantId: TENANT_ID,
        invoiceId: INVOICE_ID,
        period: '2026-04',
        reason: 'ยอดเงินในสลิปไม่ตรงกับใบแจ้งหนี้',
      });
      expect(notification.enqueuePaymentApproved).not.toHaveBeenCalled();
    });

    it('does NOT enqueue on idempotent re-reject (already rejected)', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'rejected',
        invoiceId: INVOICE_ID,
      });

      await service.reject(PAYMENT_ID, 'still bad');

      expect(notification.enqueuePaymentRejected).not.toHaveBeenCalled();
    });
  });
});
