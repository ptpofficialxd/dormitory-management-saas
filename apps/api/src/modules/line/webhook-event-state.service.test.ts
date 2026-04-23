import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `WebhookEventStateService`.
 *
 *   - markProcessed wraps the UPDATE in `withTenant({ companyId })` so RLS
 *     sees the right scope (the table is RLS-policied on companyId).
 *   - markProcessed sets `status='processed'` + stamps `processedAt`.
 *   - markFailed truncates long error messages to fit the VarChar(1024).
 *   - markFailed swallows DB failures so the BullMQ failure listener can't
 *     re-fire on its own crash.
 */

const mockUpdate = vi.fn();
const mockWithTenant = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    webhookEvent: {
      update: mockUpdate,
    },
  },
  withTenant: mockWithTenant,
}));

const { WebhookEventStateService } = await import('./webhook-event-state.service.js');

const COMPANY_ID = '11111111-1111-1111-8111-111111111111';
const ROW_ID = 'row-uuid';

describe('WebhookEventStateService', () => {
  let service: InstanceType<typeof WebhookEventStateService>;

  beforeEach(() => {
    mockUpdate.mockReset();
    mockWithTenant.mockReset();
    mockWithTenant.mockImplementation(async (_ctx: unknown, fn: () => Promise<unknown>) => fn());
    mockUpdate.mockResolvedValue({ id: ROW_ID });
    service = new WebhookEventStateService();
  });

  // -----------------------------------------------------------------------
  // markProcessed
  // -----------------------------------------------------------------------

  it('opens a withTenant({companyId}) scope before updating', async () => {
    await service.markProcessed({ webhookEventRowId: ROW_ID, companyId: COMPANY_ID });

    expect(mockWithTenant).toHaveBeenCalledTimes(1);
    expect(mockWithTenant.mock.calls[0]?.[0]).toEqual({ companyId: COMPANY_ID });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('sets status=processed and stamps processedAt', async () => {
    await service.markProcessed({ webhookEventRowId: ROW_ID, companyId: COMPANY_ID });

    const arg = mockUpdate.mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      where: { id: ROW_ID },
      data: { status: 'processed' },
    });
    expect(arg.data.processedAt).toBeInstanceOf(Date);
  });

  // -----------------------------------------------------------------------
  // markFailed
  // -----------------------------------------------------------------------

  it('writes failed status with retry count + truncated error', async () => {
    const longMsg = `${'x'.repeat(2_000)}-tail`;
    await service.markFailed({
      webhookEventRowId: ROW_ID,
      companyId: COMPANY_ID,
      error: new Error(longMsg),
      attemptsMade: 5,
    });

    expect(mockWithTenant).toHaveBeenCalledTimes(1);
    expect(mockWithTenant.mock.calls[0]?.[0]).toEqual({ companyId: COMPANY_ID });

    const updateArg = mockUpdate.mock.calls[0]?.[0];
    expect(updateArg.data.status).toBe('failed');
    expect(updateArg.data.retryCount).toBe(5);
    expect(updateArg.data.processingError.length).toBeLessThanOrEqual(1024);
    expect(updateArg.data.processingError.endsWith('…')).toBe(true);
  });

  it('strips ANSI escape sequences from the error before storing', async () => {
    const ansi = '\x1B[31mboom\x1B[0m';
    await service.markFailed({
      webhookEventRowId: ROW_ID,
      companyId: COMPANY_ID,
      error: new Error(ansi),
      attemptsMade: 1,
    });

    const updateArg = mockUpdate.mock.calls[0]?.[0];
    expect(updateArg.data.processingError).toBe('boom');
  });

  it('handles non-Error values via stringify fallback', async () => {
    await service.markFailed({
      webhookEventRowId: ROW_ID,
      companyId: COMPANY_ID,
      error: { code: 'X', detail: 'value' },
      attemptsMade: 2,
    });

    const updateArg = mockUpdate.mock.calls[0]?.[0];
    expect(updateArg.data.processingError).toBe('{"code":"X","detail":"value"}');
  });

  it('swallows DB errors during markFailed (no rethrow)', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('DB down'));
    await expect(
      service.markFailed({
        webhookEventRowId: ROW_ID,
        companyId: COMPANY_ID,
        error: new Error('original failure'),
        attemptsMade: 5,
      }),
    ).resolves.toBeUndefined();
  });
});
