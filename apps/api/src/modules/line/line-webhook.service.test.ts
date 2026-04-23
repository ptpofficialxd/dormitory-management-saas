import { createHmac } from 'node:crypto';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for LineWebhookService — mocks `@dorm/db`, the
 * `CompanyLineChannelService` and the BullMQ `Queue` so we can exercise
 * the orchestration logic in isolation:
 *
 *   - Resolves slug → channel via channelService
 *   - 404 on missing channel
 *   - 401 on bad signature (HMAC mismatch / wrong secret / missing header)
 *   - 400 on malformed JSON / Zod failure
 *   - Each event in batch → INSERT WebhookEvent + enqueue BullMQ job
 *   - Dedup: prior findFirst hit → skip insert + skip enqueue
 *   - Dedup: P2002 race → swallow + count as duplicate, no enqueue
 *   - Per-event withTenant({companyId}) opens a fresh RLS scope
 *   - BullMQ failure logged but request still succeeds (no LINE 5xx)
 */

const mockFindFirst = vi.fn();
const mockCreate = vi.fn();
const mockWithTenant = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    webhookEvent: {
      findFirst: mockFindFirst,
      create: mockCreate,
    },
  },
  withTenant: mockWithTenant,
  Prisma: {},
}));

const { LineWebhookService } = await import('./line-webhook.service.js');

const COMPANY_ID = '22222222-2222-2222-8222-222222222222';
const COMPANY_SLUG = 'dorm-hq';
const CHANNEL_ID = '1234567890';
const CHANNEL_SECRET = '0123456789abcdef0123456789abcdef';
const CHANNEL_ACCESS_TOKEN = 'a'.repeat(80);

const baseChannel = {
  id: 'cccc-cccc-cccc-cccc',
  companyId: COMPANY_ID,
  channelId: CHANNEL_ID,
  channelSecret: CHANNEL_SECRET,
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  basicId: '@dormhq',
  displayName: 'Dorm HQ',
  createdAt: new Date('2026-04-22T00:00:00Z'),
  updatedAt: new Date('2026-04-22T00:00:00Z'),
};

class FakeChannelService {
  findByCompanySlugUnscoped = vi.fn();
}

class FakeQueue {
  add = vi.fn().mockResolvedValue(undefined);
}

function signJsonBody(body: object, secret = CHANNEL_SECRET): { rawBody: Buffer; sig: string } {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  const sig = createHmac('sha256', secret).update(rawBody).digest('base64');
  return { rawBody, sig };
}

describe('LineWebhookService', () => {
  let channelService: FakeChannelService;
  let queue: FakeQueue;
  let service: InstanceType<typeof LineWebhookService>;

  beforeEach(() => {
    mockFindFirst.mockReset();
    mockCreate.mockReset();
    mockWithTenant.mockReset();
    // Default: withTenant just runs the inner fn (RLS is mocked at the prisma boundary).
    mockWithTenant.mockImplementation(async (_ctx: unknown, fn: () => Promise<unknown>) => fn());

    channelService = new FakeChannelService();
    queue = new FakeQueue();
    service = new LineWebhookService(
      // biome-ignore lint/suspicious/noExplicitAny: structural typing across test boundary
      channelService as any,
      // biome-ignore lint/suspicious/noExplicitAny: structural typing across test boundary
      queue as any,
    );
  });

  // -----------------------------------------------------------------------
  // Channel resolution
  // -----------------------------------------------------------------------

  it('throws NotFoundException when no channel is configured for the slug', async () => {
    channelService.findByCompanySlugUnscoped.mockResolvedValueOnce(null);
    const { rawBody, sig } = signJsonBody({ destination: CHANNEL_ID, events: [] });
    await expect(
      service.handleWebhook({ companySlug: 'unknown', rawBody, signatureHeader: sig }),
    ).rejects.toThrow(NotFoundException);
    expect(channelService.findByCompanySlugUnscoped).toHaveBeenCalledWith('unknown');
  });

  // -----------------------------------------------------------------------
  // Signature verification
  // -----------------------------------------------------------------------

  it('throws UnauthorizedException when signature header is missing', async () => {
    channelService.findByCompanySlugUnscoped.mockResolvedValueOnce(baseChannel);
    const { rawBody } = signJsonBody({ destination: CHANNEL_ID, events: [] });
    await expect(
      service.handleWebhook({
        companySlug: COMPANY_SLUG,
        rawBody,
        signatureHeader: undefined,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when signature does not match the body', async () => {
    channelService.findByCompanySlugUnscoped.mockResolvedValueOnce(baseChannel);
    const { rawBody } = signJsonBody({ destination: CHANNEL_ID, events: [] });
    // 44-char base64 string but garbage bytes — passes length check, fails HMAC.
    const badSig = 'A'.repeat(44);
    await expect(
      service.handleWebhook({
        companySlug: COMPANY_SLUG,
        rawBody,
        signatureHeader: badSig,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when signature was made with a different secret', async () => {
    channelService.findByCompanySlugUnscoped.mockResolvedValueOnce(baseChannel);
    const { rawBody, sig } = signJsonBody(
      { destination: CHANNEL_ID, events: [] },
      'wrong-secret-wrong-secret-wrong00',
    );
    await expect(
      service.handleWebhook({
        companySlug: COMPANY_SLUG,
        rawBody,
        signatureHeader: sig,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  // -----------------------------------------------------------------------
  // Body validation
  // -----------------------------------------------------------------------

  it('throws BadRequestException on non-JSON body (signature still passes byte check)', async () => {
    channelService.findByCompanySlugUnscoped.mockResolvedValueOnce(baseChannel);
    const rawBody = Buffer.from('not json', 'utf8');
    // Sign the garbage body so we get past signature check and trip JSON.parse.
    const sig = createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('base64');
    await expect(
      service.handleWebhook({
        companySlug: COMPANY_SLUG,
        rawBody,
        signatureHeader: sig,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException on Zod validation failure (missing destination)', async () => {
    channelService.findByCompanySlugUnscoped.mockResolvedValueOnce(baseChannel);
    const { rawBody, sig } = signJsonBody({ events: [] });
    await expect(
      service.handleWebhook({
        companySlug: COMPANY_SLUG,
        rawBody,
        signatureHeader: sig,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // -----------------------------------------------------------------------
  // Empty batch — LINE "Verify" button
  // -----------------------------------------------------------------------

  it('returns ok with zero counts on empty events array (LINE Verify ping)', async () => {
    channelService.findByCompanySlugUnscoped.mockResolvedValueOnce(baseChannel);
    const { rawBody, sig } = signJsonBody({ destination: CHANNEL_ID, events: [] });
    const out = await service.handleWebhook({
      companySlug: COMPANY_SLUG,
      rawBody,
      signatureHeader: sig,
    });
    expect(out).toEqual({ ok: true, processed: 0, deduped: 0 });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Happy path: insert + enqueue
  // -----------------------------------------------------------------------

  it('inserts WebhookEvent and enqueues a job for a fresh event', async () => {
    channelService.findByCompanySlugUnscoped.mockResolvedValueOnce(baseChannel);
    mockFindFirst.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({ id: 'webhook-row-id-001' });

    const event = {
      type: 'message',
      timestamp: 1714000000000,
      webhookEventId: 'wh-evt-001',
      source: { type: 'user', userId: 'U_user_001' },
      replyToken: 'reply-token-001',
      message: { type: 'text', id: 'msg-001', text: 'สวัสดี' },
    };
    const { rawBody, sig } = signJsonBody({ destination: CHANNEL_ID, events: [event] });

    const out = await service.handleWebhook({
      companySlug: COMPANY_SLUG,
      rawBody,
      signatureHeader: sig,
    });

    expect(out).toEqual({ ok: true, processed: 1, deduped: 0 });

    // withTenant scoped to companyId (NOT bypass).
    // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
    const ctxArg = mockWithTenant.mock.calls[0]![0];
    expect(ctxArg).toEqual({ companyId: COMPANY_ID });

    // INSERT carried the right shape.
    // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
    const createArg = mockCreate.mock.calls[0]![0];
    expect(createArg.data.companyId).toBe(COMPANY_ID);
    expect(createArg.data.eventId).toBe('wh-evt-001');
    expect(createArg.data.eventType).toBe('message');
    expect(createArg.data.channelId).toBe(CHANNEL_ID);
    expect(createArg.data.lineUserId).toBe('U_user_001');
    expect(createArg.data.status).toBe('pending');
    expect(createArg.data.eventTimestamp).toEqual(new Date(1714000000000));

    // Enqueue carried jobId for BullMQ-level dedup.
    expect(queue.add).toHaveBeenCalledTimes(1);
    // biome-ignore lint/style/noNonNullAssertion: call asserted above
    const [jobName, jobData, jobOpts] = queue.add.mock.calls[0]!;
    expect(jobName).toBe('line-webhook-event');
    expect(jobData).toMatchObject({
      webhookEventRowId: 'webhook-row-id-001',
      companyId: COMPANY_ID,
      eventId: 'wh-evt-001',
      eventType: 'message',
    });
    expect(jobOpts.jobId).toBe(`${COMPANY_ID}:wh-evt-001`);
    expect(jobOpts.attempts).toBe(5);
  });

  // -----------------------------------------------------------------------
  // Dedup
  // -----------------------------------------------------------------------

  it('skips insert + enqueue when the event was already recorded (findFirst hit)', async () => {
    channelService.findByCompanySlugUnscoped.mockResolvedValueOnce(baseChannel);
    mockFindFirst.mockResolvedValueOnce({ id: 'webhook-row-id-existing' });

    const event = {
      type: 'follow',
      timestamp: 1714000000001,
      webhookEventId: 'wh-evt-dup',
      source: { type: 'user', userId: 'U_user_002' },
      replyToken: 'reply-token-002',
    };
    const { rawBody, sig } = signJsonBody({ destination: CHANNEL_ID, events: [event] });

    const out = await service.handleWebhook({
      companySlug: COMPANY_SLUG,
      rawBody,
      signatureHeader: sig,
    });

    expect(out).toEqual({ ok: true, processed: 0, deduped: 1 });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('treats a P2002 race during INSERT as a duplicate (no enqueue, no throw)', async () => {
    channelService.findByCompanySlugUnscoped.mockResolvedValueOnce(baseChannel);
    mockFindFirst.mockResolvedValueOnce(null);
    // Concurrent redelivery committed between findFirst and create.
    mockCreate.mockRejectedValueOnce({ code: 'P2002' });

    const event = {
      type: 'message',
      timestamp: 1714000000002,
      webhookEventId: 'wh-evt-race',
      source: { type: 'user', userId: 'U_user_003' },
      message: { type: 'text', id: 'msg-002', text: 'race' },
    };
    const { rawBody, sig } = signJsonBody({ destination: CHANNEL_ID, events: [event] });

    const out = await service.handleWebhook({
      companySlug: COMPANY_SLUG,
      rawBody,
      signatureHeader: sig,
    });

    expect(out).toEqual({ ok: true, processed: 0, deduped: 1 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rethrows non-P2002 prisma errors so LINE will retry the delivery', async () => {
    channelService.findByCompanySlugUnscoped.mockResolvedValueOnce(baseChannel);
    mockFindFirst.mockResolvedValueOnce(null);
    mockCreate.mockRejectedValueOnce({ code: 'P2003', message: 'fk violation' });

    const event = {
      type: 'message',
      timestamp: 1714000000003,
      webhookEventId: 'wh-evt-err',
      source: { type: 'user', userId: 'U_user_004' },
      message: { type: 'text', id: 'msg-003', text: 'boom' },
    };
    const { rawBody, sig } = signJsonBody({ destination: CHANNEL_ID, events: [event] });

    await expect(
      service.handleWebhook({
        companySlug: COMPANY_SLUG,
        rawBody,
        signatureHeader: sig,
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  // -----------------------------------------------------------------------
  // Batch handling
  // -----------------------------------------------------------------------

  it('processes a batch with mixed new + duplicate events independently', async () => {
    channelService.findByCompanySlugUnscoped.mockResolvedValueOnce(baseChannel);
    // Event 1 is new, Event 2 is duplicate, Event 3 is new.
    mockFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'existing-2' })
      .mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({ id: 'row-1' }).mockResolvedValueOnce({ id: 'row-3' });

    const events = [
      {
        type: 'message',
        timestamp: 1714000001000,
        webhookEventId: 'evt-1',
        source: { type: 'user', userId: 'U1' },
        message: { type: 'text', id: 'm1', text: '1' },
      },
      {
        type: 'follow',
        timestamp: 1714000002000,
        webhookEventId: 'evt-2',
        source: { type: 'user', userId: 'U2' },
      },
      {
        type: 'unfollow',
        timestamp: 1714000003000,
        webhookEventId: 'evt-3',
        source: { type: 'user', userId: 'U3' },
      },
    ];
    const { rawBody, sig } = signJsonBody({ destination: CHANNEL_ID, events });

    const out = await service.handleWebhook({
      companySlug: COMPANY_SLUG,
      rawBody,
      signatureHeader: sig,
    });

    expect(out).toEqual({ ok: true, processed: 2, deduped: 1 });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledTimes(2);
    // Each event opens its OWN withTenant boundary.
    expect(mockWithTenant).toHaveBeenCalledTimes(3);
  });

  // -----------------------------------------------------------------------
  // BullMQ resilience
  // -----------------------------------------------------------------------

  it('still returns 200 + counts when BullMQ enqueue fails (row stays pending for reconcile)', async () => {
    channelService.findByCompanySlugUnscoped.mockResolvedValueOnce(baseChannel);
    mockFindFirst.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({ id: 'row-1' });
    queue.add.mockRejectedValueOnce(new Error('redis down'));

    const event = {
      type: 'message',
      timestamp: 1714000004000,
      webhookEventId: 'evt-redis-down',
      source: { type: 'user', userId: 'U1' },
      message: { type: 'text', id: 'm1', text: 'hi' },
    };
    const { rawBody, sig } = signJsonBody({ destination: CHANNEL_ID, events: [event] });

    const out = await service.handleWebhook({
      companySlug: COMPANY_SLUG,
      rawBody,
      signatureHeader: sig,
    });

    // Row was inserted → counted as processed even though enqueue failed
    // (Task #40 reconcile sweep will pick the pending row up).
    expect(out).toEqual({ ok: true, processed: 1, deduped: 0 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Synthetic eventId fallback
  // -----------------------------------------------------------------------

  it('falls back to a synthetic eventId when webhookEventId is missing', async () => {
    channelService.findByCompanySlugUnscoped.mockResolvedValueOnce(baseChannel);
    mockFindFirst.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({ id: 'row-synth' });

    const event = {
      type: 'message',
      timestamp: 1714000005000,
      // webhookEventId intentionally omitted (legacy LINE delivery shape).
      source: { type: 'user', userId: 'U_legacy' },
      message: { type: 'text', id: 'm-legacy', text: 'old' },
    };
    const { rawBody, sig } = signJsonBody({ destination: CHANNEL_ID, events: [event] });

    const out = await service.handleWebhook({
      companySlug: COMPANY_SLUG,
      rawBody,
      signatureHeader: sig,
    });

    expect(out).toEqual({ ok: true, processed: 1, deduped: 0 });
    // biome-ignore lint/style/noNonNullAssertion: call asserted above
    const createArg = mockCreate.mock.calls[0]![0];
    expect(createArg.data.eventId).toMatch(/^synth-[0-9a-f]+-1714000005000$/);
  });
});
