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
 *   - State machine — confirm:
 *       pending → confirmed (happy + invoice rollup runs in tx)
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
 * RLS cross-company isolation is asserted in the e2e suite (Postgres-only).
 */

const mockPaymentFindMany = vi.fn();
const mockPaymentFindUnique = vi.fn();
const mockPaymentFindFirst = vi.fn();
const mockPaymentCreate = vi.fn();
const mockPaymentUpdate = vi.fn();
const mockInvoiceFindUnique = vi.fn();
const mockInvoiceUpdate = vi.fn();
const mockTxPaymentUpdate = vi.fn();
const mockTxPaymentFindMany = vi.fn();
const mockTxInvoiceFindUnique = vi.fn();
const mockTxInvoiceUpdate = vi.fn();
const mockTransaction = vi.fn();
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
      update: mockInvoiceUpdate,
    },
    $transaction: mockTransaction,
  },
  getTenantContext: mockGetTenantContext,
  Prisma: {},
}));

const { PaymentService } = await import('./payment.service.js');

const COMPANY_ID = '11111111-1111-1111-8111-111111111111';
const INVOICE_ID = '22222222-2222-2222-8222-222222222222';
const FOREIGN_INVOICE_ID = '99999999-9999-9999-8999-999999999999';
const TENANT_ID = '33333333-3333-3333-8333-333333333333';
const PAYMENT_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_USER_ID = '55555555-5555-5555-8555-555555555555';
const IDEMPOTENCY_KEY = '01HNV4YGZJK5TX1Z3F8H9ABCDEF';

/** Minimal Decimal-shape mock — `toString()` is all the service consumes. */
const dec = (s: string) => ({ toString: () => s });

/**
 * Tx callback invoker — wires the mocks for tx.payment.update and
 * tx.invoice.findUnique/update to a fresh test-controlled set per test.
 */
function makeTx() {
  return {
    payment: {
      update: mockTxPaymentUpdate,
      findMany: mockTxPaymentFindMany,
    },
    invoice: {
      findUnique: mockTxInvoiceFindUnique,
      update: mockTxInvoiceUpdate,
    },
  };
}

describe('PaymentService', () => {
  let service: InstanceType<typeof PaymentService>;

  beforeEach(() => {
    mockPaymentFindMany.mockReset();
    mockPaymentFindUnique.mockReset();
    mockPaymentFindFirst.mockReset();
    mockPaymentCreate.mockReset();
    mockPaymentUpdate.mockReset();
    mockInvoiceFindUnique.mockReset();
    mockInvoiceUpdate.mockReset();
    mockTxPaymentUpdate.mockReset();
    mockTxPaymentFindMany.mockReset();
    mockTxInvoiceFindUnique.mockReset();
    mockTxInvoiceUpdate.mockReset();
    mockTransaction.mockReset();
    mockGetTenantContext.mockReset();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });
    // Default: invoke the callback with a synthetic tx so the implementation
    // sees a usable interface. Tests that need to assert tx-internals
    // override the per-mock impls.
    mockTransaction.mockImplementation(async (cb: (tx: ReturnType<typeof makeTx>) => unknown) =>
      cb(makeTx()),
    );
    service = new PaymentService();
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
    });

    it('forwards optional paidAt as a Date when provided', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        tenantId: TENANT_ID,
        status: 'issued',
        total: dec('4800.00'),
      });
      mockPaymentCreate.mockResolvedValueOnce({ id: PAYMENT_ID });

      await service.create({ ...baseInput, paidAt: '2026-04-20T10:30:00.000Z' }, IDEMPOTENCY_KEY);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockPaymentCreate.mock.calls[0]![0];
      expect(args.data.paidAt).toBeInstanceOf(Date);
      expect((args.data.paidAt as Date).toISOString()).toBe('2026-04-20T10:30:00.000Z');
    });

    it('idempotency: P2002 on (company_id, idempotency_key) → returns existing row (no throw)', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        tenantId: TENANT_ID,
        status: 'issued',
        total: dec('4800.00'),
      });
      const p2002 = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['company_id', 'idempotency_key'] },
      });
      mockPaymentCreate.mockRejectedValueOnce(p2002);
      const existing = { id: PAYMENT_ID, status: 'pending', idempotencyKey: IDEMPOTENCY_KEY };
      mockPaymentFindFirst.mockResolvedValueOnce(existing);

      const result = await service.create(baseInput, IDEMPOTENCY_KEY);

      expect(result).toBe(existing);
      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const lookupArgs = mockPaymentFindFirst.mock.calls[0]![0];
      expect(lookupArgs.where).toEqual({ idempotencyKey: IDEMPOTENCY_KEY });
    });

    it('rethrows non-P2002 Prisma errors untouched', async () => {
      mockInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        tenantId: TENANT_ID,
        status: 'issued',
        total: dec('4800.00'),
      });
      mockPaymentCreate.mockRejectedValueOnce(new Error('boom'));
      await expect(service.create(baseInput, IDEMPOTENCY_KEY)).rejects.toThrow('boom');
    });
  });

  // ===================================================================
  // confirm — state machine + invoice rollup
  // ===================================================================

  describe('confirm', () => {
    it('flips pending → confirmed inside a transaction with confirmedByUserId', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
        amount: dec('4800.00'),
      });
      mockTxPaymentUpdate.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'confirmed',
        invoiceId: INVOICE_ID,
      });
      mockTxInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        total: dec('4800.00'),
        status: 'issued',
      });
      mockTxPaymentFindMany.mockResolvedValueOnce([{ amount: dec('4800.00') }]);

      await service.confirm(PAYMENT_ID, ADMIN_USER_ID, 'looks legit');

      // tx.payment.update assertions
      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const updArgs = mockTxPaymentUpdate.mock.calls[0]![0];
      expect(updArgs.data.status).toBe('confirmed');
      expect(updArgs.data.confirmedByUserId).toBe(ADMIN_USER_ID);
      expect(updArgs.data.confirmedAt).toBeInstanceOf(Date);
    });

    it('is idempotent on already-confirmed (no DB hit, returns row)', async () => {
      const existing = { id: PAYMENT_ID, status: 'confirmed', invoiceId: INVOICE_ID };
      mockPaymentFindUnique.mockResolvedValueOnce(existing);

      const result = await service.confirm(PAYMENT_ID, ADMIN_USER_ID);

      expect(result).toBe(existing);
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('refuses rejected → confirm with 409 PaymentAlreadyRejected', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'rejected',
        invoiceId: INVOICE_ID,
      });
      await expect(service.confirm(PAYMENT_ID, ADMIN_USER_ID)).rejects.toThrow(ConflictException);
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('rollup: confirmed sum == total → invoice.status = paid', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
      });
      mockTxPaymentUpdate.mockResolvedValueOnce({ id: PAYMENT_ID, invoiceId: INVOICE_ID });
      mockTxInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        total: dec('4800.00'),
        status: 'issued',
      });
      mockTxPaymentFindMany.mockResolvedValueOnce([{ amount: dec('4800.00') }]);

      await service.confirm(PAYMENT_ID, ADMIN_USER_ID);

      // biome-ignore lint/style/noNonNullAssertion: rollup MUST run and update invoice
      const updArgs = mockTxInvoiceUpdate.mock.calls[0]![0];
      expect(updArgs.data.status).toBe('paid');
    });

    it('rollup: confirmed sum > total (overpayment) → invoice.status = paid', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
      });
      mockTxPaymentUpdate.mockResolvedValueOnce({ id: PAYMENT_ID, invoiceId: INVOICE_ID });
      mockTxInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        total: dec('4800.00'),
        status: 'issued',
      });
      mockTxPaymentFindMany.mockResolvedValueOnce([
        { amount: dec('4800.00') },
        { amount: dec('100.00') }, // overpayment
      ]);

      await service.confirm(PAYMENT_ID, ADMIN_USER_ID);

      // biome-ignore lint/style/noNonNullAssertion: rollup MUST mark fully paid
      const updArgs = mockTxInvoiceUpdate.mock.calls[0]![0];
      expect(updArgs.data.status).toBe('paid');
    });

    it('rollup: 0 < confirmed sum < total → invoice.status = partially_paid', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
      });
      mockTxPaymentUpdate.mockResolvedValueOnce({ id: PAYMENT_ID, invoiceId: INVOICE_ID });
      mockTxInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        total: dec('4800.00'),
        status: 'issued',
      });
      mockTxPaymentFindMany.mockResolvedValueOnce([{ amount: dec('2400.00') }]);

      await service.confirm(PAYMENT_ID, ADMIN_USER_ID);

      // biome-ignore lint/style/noNonNullAssertion: rollup MUST mark partial
      const updArgs = mockTxInvoiceUpdate.mock.calls[0]![0];
      expect(updArgs.data.status).toBe('partially_paid');
    });

    it('rollup: void invoice is skipped (no status flip)', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
      });
      mockTxPaymentUpdate.mockResolvedValueOnce({ id: PAYMENT_ID, invoiceId: INVOICE_ID });
      mockTxInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        total: dec('4800.00'),
        status: 'void',
      });

      await service.confirm(PAYMENT_ID, ADMIN_USER_ID);

      expect(mockTxPaymentFindMany).not.toHaveBeenCalled(); // short-circuited
      expect(mockTxInvoiceUpdate).not.toHaveBeenCalled();
    });

    it('rollup: skip when next status equals current (avoid no-op write + audit noise)', async () => {
      mockPaymentFindUnique.mockResolvedValueOnce({
        id: PAYMENT_ID,
        status: 'pending',
        invoiceId: INVOICE_ID,
      });
      mockTxPaymentUpdate.mockResolvedValueOnce({ id: PAYMENT_ID, invoiceId: INVOICE_ID });
      mockTxInvoiceFindUnique.mockResolvedValueOnce({
        id: INVOICE_ID,
        total: dec('4800.00'),
        status: 'partially_paid', // already partial
      });
      mockTxPaymentFindMany.mockResolvedValueOnce([{ amount: dec('2400.00') }]);

      await service.confirm(PAYMENT_ID, ADMIN_USER_ID);

      // computed = partially_paid, current = partially_paid → no write
      expect(mockTxInvoiceUpdate).not.toHaveBeenCalled();
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
  });
});
