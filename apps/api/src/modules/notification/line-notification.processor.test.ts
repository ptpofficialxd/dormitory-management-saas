import type { CompanyLineChannel } from '@dorm/shared/zod';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for LineNotificationProcessor (Task #83).
 *
 * Tested branches:
 *   process(job):
 *     - happy path → pushMessage called with rendered text + access token
 *     - tenant missing → soft-skip (no push, no throw)
 *     - tenant unbound (lineUserId null) → soft-skip
 *     - tenant inactive → soft-skip
 *     - channel missing → soft-skip
 *     - LineMessagingPermanentError → swallowed, returns ok
 *     - other error (LineMessagingClientError) → rethrown for retry
 *
 *   onFailed(job, err):
 *     - non-final attempt → log only (no DB writes — notifications are
 *       fire-and-forget per Task #83 design)
 *     - exhausted → log only
 */

const mockTenantFindUnique = vi.fn();
const mockWithTenant = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    tenant: {
      findUnique: mockTenantFindUnique,
    },
  },
  withTenant: mockWithTenant,
}));

// Mock the env module so template renderers have a deterministic LIFF URL.
vi.mock('../../config/env.js', () => ({
  env: {
    LIFF_BIND_URL: 'https://liff.line.me/1234567890-test',
  },
}));

// Import the SUT + the LINE error type after the mocks are in place.
const { LineNotificationProcessor } = await import('./line-notification.processor.js');
const { LineMessagingPermanentError } = await import('../line/line-messaging.client.js');

const COMPANY_ID = '11111111-1111-1111-8111-111111111111';
const COMPANY_SLUG = 'easyslip';
const TENANT_ID = '22222222-2222-2222-8222-222222222222';
const INVOICE_ID = '33333333-3333-3333-8333-333333333333';
const PERIOD = '2026-04';
const LINE_USER_ID = `U${'1'.repeat(32)}`;

const CHANNEL: CompanyLineChannel = {
  id: 'cccc-cccc',
  companyId: COMPANY_ID,
  channelId: '1234567890',
  channelSecret: 'channel-secret-32-chars-long-aaaa',
  channelAccessToken: 'channel-access-token-zzzzzzzzzzzz',
  basicId: '@dorm',
  displayName: 'Dorm OA',
  createdAt: new Date('2026-04-22T00:00:00Z'),
  updatedAt: new Date('2026-04-22T00:00:00Z'),
} as unknown as CompanyLineChannel;

class FakeChannelService {
  findByCompanyIdUnscoped = vi.fn();
}

class FakeMessaging {
  pushMessage = vi.fn();
  // The class also has replyMessage but the processor never calls it.
  replyMessage = vi.fn();
}

/**
 * Push-API arg shape — mirrors `LineMessagingClient.pushMessage` so we can
 * type-narrow `mock.lastCall` without scattering casts. We don't import the
 * real type because LineMessagingClient.PushArgs is private to the client
 * file; mirroring the structural shape here is good enough for a test.
 */
type PushArgs = {
  to: string;
  accessToken: string;
  messages: Array<{ type: string; text: string }>;
};

/**
 * Pull the last `pushMessage` call's first argument with TS narrowing.
 * Throws (failing the test) if no call was made — eliminates the
 * possibly-undefined access pattern that trips `noUncheckedIndexedAccess`.
 */
function lastPushArgs(messaging: FakeMessaging): PushArgs {
  const call = messaging.pushMessage.mock.lastCall;
  if (!call) {
    throw new Error('pushMessage was not called');
  }
  return call[0] as PushArgs;
}

/**
 * Convenience: fetch only the rendered `text` from the last push.
 * `messages` is always a 1-element array per our render contract, so we
 * pull the first message's text. Falls back to '' if the array is somehow
 * empty (defensive — shouldn't happen if render contract holds).
 */
function lastPushedText(messaging: FakeMessaging): string {
  return lastPushArgs(messaging).messages[0]?.text ?? '';
}

function makeJob(overrides?: {
  data?: object;
  attemptsMade?: number;
  opts?: { attempts: number };
}): Job {
  return {
    data: {
      kind: 'invoice_issued',
      companyId: COMPANY_ID,
      companySlug: COMPANY_SLUG,
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      period: PERIOD,
      totalAmount: '5500.00',
      dueDate: '2026-04-30',
      ...overrides?.data,
    },
    attemptsMade: overrides?.attemptsMade ?? 1,
    opts: overrides?.opts ?? { attempts: 3 },
  } as unknown as Job;
}

describe('LineNotificationProcessor', () => {
  let channelService: FakeChannelService;
  let messaging: FakeMessaging;
  let processor: InstanceType<typeof LineNotificationProcessor>;

  beforeEach(() => {
    mockTenantFindUnique.mockReset();
    mockWithTenant.mockReset();
    mockWithTenant.mockImplementation(async (_ctx: unknown, fn: () => Promise<unknown>) => fn());

    channelService = new FakeChannelService();
    messaging = new FakeMessaging();

    processor = new LineNotificationProcessor(
      // biome-ignore lint/suspicious/noExplicitAny: structural typing across test boundary
      channelService as any,
      // biome-ignore lint/suspicious/noExplicitAny: structural typing across test boundary
      messaging as any,
    );
  });

  // -----------------------------------------------------------------------
  // Happy path — full pipeline
  // -----------------------------------------------------------------------

  it('pushes a rendered message when tenant is bound + channel is configured', async () => {
    mockTenantFindUnique.mockResolvedValueOnce({
      lineUserId: LINE_USER_ID,
      status: 'active',
    });
    channelService.findByCompanyIdUnscoped.mockResolvedValueOnce(CHANNEL);
    messaging.pushMessage.mockResolvedValueOnce(undefined);

    const result = await processor.process(makeJob());

    expect(result).toEqual({ ok: true });
    expect(channelService.findByCompanyIdUnscoped).toHaveBeenCalledWith(COMPANY_ID);
    expect(messaging.pushMessage).toHaveBeenCalledTimes(1);
    const args = lastPushArgs(messaging);
    expect(args.to).toBe(LINE_USER_ID);
    expect(args.accessToken).toBe(CHANNEL.channelAccessToken);
    expect(args.messages).toHaveLength(1);
    expect(args.messages[0]?.type).toBe('text');
    expect(args.messages[0]?.text).toContain('📄 ใบแจ้งหนี้รอบ 2026-04');
    expect(args.messages[0]?.text).toContain('5,500.00');
  });

  // -----------------------------------------------------------------------
  // Soft-skip branches
  // -----------------------------------------------------------------------

  it('soft-skips when the tenant row was deleted', async () => {
    mockTenantFindUnique.mockResolvedValueOnce(null);

    const result = await processor.process(makeJob());

    expect(result).toEqual({ ok: true, skipped: 'tenant-missing' });
    expect(messaging.pushMessage).not.toHaveBeenCalled();
  });

  it('soft-skips when the tenant has no lineUserId (not bound)', async () => {
    mockTenantFindUnique.mockResolvedValueOnce({
      lineUserId: null,
      status: 'active',
    });

    const result = await processor.process(makeJob());

    expect(result).toEqual({ ok: true, skipped: 'unbound-tenant' });
    expect(messaging.pushMessage).not.toHaveBeenCalled();
    expect(channelService.findByCompanyIdUnscoped).not.toHaveBeenCalled();
  });

  it('soft-skips when the tenant is no longer active (e.g. moved_out)', async () => {
    mockTenantFindUnique.mockResolvedValueOnce({
      lineUserId: LINE_USER_ID,
      status: 'moved_out',
    });

    const result = await processor.process(makeJob());

    expect(result).toEqual({ ok: true, skipped: 'tenant-inactive' });
    expect(messaging.pushMessage).not.toHaveBeenCalled();
  });

  it('soft-skips when the company has no LINE channel configured', async () => {
    mockTenantFindUnique.mockResolvedValueOnce({
      lineUserId: LINE_USER_ID,
      status: 'active',
    });
    channelService.findByCompanyIdUnscoped.mockResolvedValueOnce(null);

    const result = await processor.process(makeJob());

    expect(result).toEqual({ ok: true, skipped: 'channel-missing' });
    expect(messaging.pushMessage).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // LINE error handling
  // -----------------------------------------------------------------------

  it('absorbs LineMessagingPermanentError (4xx) — no retry', async () => {
    mockTenantFindUnique.mockResolvedValueOnce({
      lineUserId: LINE_USER_ID,
      status: 'active',
    });
    channelService.findByCompanyIdUnscoped.mockResolvedValueOnce(CHANNEL);
    messaging.pushMessage.mockRejectedValueOnce(
      new LineMessagingPermanentError('User blocked the OA', 403, '{"message":"forbidden"}'),
    );

    const result = await processor.process(makeJob());

    expect(result).toEqual({ ok: true, skipped: 'line-permanent-error' });
  });

  it('rethrows non-permanent errors so BullMQ retries', async () => {
    mockTenantFindUnique.mockResolvedValueOnce({
      lineUserId: LINE_USER_ID,
      status: 'active',
    });
    channelService.findByCompanyIdUnscoped.mockResolvedValueOnce(CHANNEL);
    messaging.pushMessage.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(processor.process(makeJob())).rejects.toThrow('ECONNRESET');
  });

  // -----------------------------------------------------------------------
  // Per-kind rendering — verify discriminator dispatch works
  // -----------------------------------------------------------------------

  it('renders payment_approved without a LIFF link', async () => {
    mockTenantFindUnique.mockResolvedValueOnce({
      lineUserId: LINE_USER_ID,
      status: 'active',
    });
    channelService.findByCompanyIdUnscoped.mockResolvedValueOnce(CHANNEL);
    messaging.pushMessage.mockResolvedValueOnce(undefined);

    await processor.process(
      makeJob({
        data: {
          kind: 'payment_approved',
          totalAmount: undefined,
          dueDate: undefined,
        },
      }),
    );

    const text = lastPushedText(messaging);
    expect(text).toContain('✅ ยืนยันการชำระบิลรอบ 2026-04');
    expect(text).not.toContain('https://liff.line.me');
  });

  it('renders payment_rejected with the reason verbatim', async () => {
    mockTenantFindUnique.mockResolvedValueOnce({
      lineUserId: LINE_USER_ID,
      status: 'active',
    });
    channelService.findByCompanyIdUnscoped.mockResolvedValueOnce(CHANNEL);
    messaging.pushMessage.mockResolvedValueOnce(undefined);

    await processor.process(
      makeJob({
        data: {
          kind: 'payment_rejected',
          reason: 'ยอดเงินไม่ตรงกับใบแจ้งหนี้',
          totalAmount: undefined,
          dueDate: undefined,
        },
      }),
    );

    const text = lastPushedText(messaging);
    expect(text).toContain('❌ สลิปบิลรอบ 2026-04');
    expect(text).toContain('ยอดเงินไม่ตรงกับใบแจ้งหนี้');
    expect(text).toContain('https://liff.line.me');
  });

  // -----------------------------------------------------------------------
  // onFailed — log-only behaviour
  // -----------------------------------------------------------------------

  it('onFailed handles a non-final transient attempt without throwing', () => {
    const job = makeJob({ attemptsMade: 2, opts: { attempts: 3 } });
    expect(() => processor.onFailed(job, new Error('boom'))).not.toThrow();
  });

  it('onFailed handles an exhausted attempt without throwing', () => {
    const job = makeJob({ attemptsMade: 3, opts: { attempts: 3 } });
    expect(() => processor.onFailed(job, new Error('boom'))).not.toThrow();
  });

  it('onFailed handles a stalled (undefined) job gracefully', () => {
    expect(() => processor.onFailed(undefined, new Error('stalled'))).not.toThrow();
  });
});
