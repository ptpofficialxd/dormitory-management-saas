import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationService } from './notification.service.js';

/**
 * Vitest's `mock.calls[N][M]` is typed as possibly-undefined under strict
 * `noUncheckedIndexedAccess`. We use `toHaveBeenCalledWith` /
 * `toHaveBeenNthCalledWith` instead of indexed access where possible —
 * idiomatic + side-steps the type narrowing dance entirely.
 */

/**
 * Unit tests for NotificationService.
 *
 * What we cover:
 *   - Each public method enqueues with the correct `kind` + payload shape
 *   - jobId is deterministic per (kind, tenantId, invoiceId) — re-enqueue safety
 *   - Producer-side errors are swallowed (logged) — caller's request still succeeds
 *
 * What we DON'T cover here:
 *   - Worker behaviour (LineNotificationProcessor has its own test)
 *   - Template rendering (notification-templates.test.ts)
 *   - End-to-end Redis/BullMQ — that's an integration test (Phase 2)
 */

const COMPANY_ID = '11111111-1111-1111-8111-111111111111';
const COMPANY_SLUG = 'easyslip';
const TENANT_ID = '22222222-2222-2222-8222-222222222222';
const INVOICE_ID = '33333333-3333-3333-8333-333333333333';
const PERIOD = '2026-04';

describe('NotificationService', () => {
  let queueAdd: ReturnType<typeof vi.fn>;
  let service: NotificationService;

  beforeEach(() => {
    queueAdd = vi.fn().mockResolvedValue(undefined);
    const queue = { add: queueAdd } as unknown as Queue;
    service = new NotificationService(queue);
  });

  // -----------------------------------------------------------------------
  // enqueueInvoiceIssued
  // -----------------------------------------------------------------------

  it('enqueues invoice_issued with the right kind + jobId', async () => {
    await service.enqueueInvoiceIssued({
      companyId: COMPANY_ID,
      companySlug: COMPANY_SLUG,
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      period: PERIOD,
      totalAmount: '5500.00',
      dueDate: '2026-04-30',
    });

    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      'invoice_issued',
      expect.objectContaining({
        kind: 'invoice_issued',
        companyId: COMPANY_ID,
        tenantId: TENANT_ID,
        invoiceId: INVOICE_ID,
        period: PERIOD,
        totalAmount: '5500.00',
        dueDate: '2026-04-30',
      }),
      { jobId: `notify:invoice_issued:${TENANT_ID}:${INVOICE_ID}` },
    );
  });

  // -----------------------------------------------------------------------
  // enqueuePaymentApproved
  // -----------------------------------------------------------------------

  it('enqueues payment_approved without extra vars beyond the envelope', async () => {
    await service.enqueuePaymentApproved({
      companyId: COMPANY_ID,
      companySlug: COMPANY_SLUG,
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      period: PERIOD,
    });

    expect(queueAdd).toHaveBeenCalledWith(
      'payment_approved',
      expect.objectContaining({ kind: 'payment_approved', period: PERIOD }),
      { jobId: `notify:payment_approved:${TENANT_ID}:${INVOICE_ID}` },
    );
  });

  // -----------------------------------------------------------------------
  // enqueuePaymentRejected
  // -----------------------------------------------------------------------

  it('enqueues payment_rejected with the reason field', async () => {
    await service.enqueuePaymentRejected({
      companyId: COMPANY_ID,
      companySlug: COMPANY_SLUG,
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      period: PERIOD,
      reason: 'ยอดเงินไม่ตรง',
    });

    expect(queueAdd).toHaveBeenCalledWith(
      'payment_rejected',
      expect.objectContaining({
        kind: 'payment_rejected',
        reason: 'ยอดเงินไม่ตรง',
      }),
      { jobId: `notify:payment_rejected:${TENANT_ID}:${INVOICE_ID}` },
    );
  });

  // -----------------------------------------------------------------------
  // Idempotency — same jobId on retry
  // -----------------------------------------------------------------------

  it('uses the same jobId for repeated enqueues of the same (kind, tenant, invoice)', async () => {
    const args = {
      companyId: COMPANY_ID,
      companySlug: COMPANY_SLUG,
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      period: PERIOD,
      totalAmount: '5500.00',
      dueDate: '2026-04-30',
    };
    await service.enqueueInvoiceIssued(args);
    await service.enqueueInvoiceIssued(args);

    expect(queueAdd).toHaveBeenCalledTimes(2);
    // Both calls must carry the same jobId — that's the dedup contract.
    // `toHaveBeenNthCalledWith` accepts the call ordinal (1-indexed).
    const expectedJobId = `notify:invoice_issued:${TENANT_ID}:${INVOICE_ID}`;
    expect(queueAdd).toHaveBeenNthCalledWith(1, expect.anything(), expect.anything(), {
      jobId: expectedJobId,
    });
    expect(queueAdd).toHaveBeenNthCalledWith(2, expect.anything(), expect.anything(), {
      jobId: expectedJobId,
    });
  });

  // -----------------------------------------------------------------------
  // Producer-side failure swallowed
  // -----------------------------------------------------------------------

  it('swallows queue.add failures (logged) so a Redis blip does not break the HTTP request', async () => {
    queueAdd.mockRejectedValueOnce(new Error('Redis is down'));

    await expect(
      service.enqueueInvoiceIssued({
        companyId: COMPANY_ID,
        companySlug: COMPANY_SLUG,
        tenantId: TENANT_ID,
        invoiceId: INVOICE_ID,
        period: PERIOD,
        totalAmount: '100.00',
        dueDate: '2026-04-30',
      }),
    ).resolves.toBeUndefined();
  });
});
