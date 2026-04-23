import type { CompanyLineChannel } from '@dorm/shared/zod';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `LineEventProcessor`.
 *
 *   process(job):
 *     - happy path → handler called, markProcessed called
 *     - row missing → swallow, no handler
 *     - row already processed → skip handler
 *     - payload invalid → throws PermanentJobError
 *     - channel disappeared → throws PermanentJobError
 *
 *   onFailed(job, err):
 *     - non-final transient attempt → no markFailed
 *     - final attempt exhausted → markFailed
 *     - PermanentJobError → markFailed regardless of attempts
 */

const mockFindUnique = vi.fn();
const mockWithTenant = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    webhookEvent: {
      findUnique: mockFindUnique,
    },
  },
  withTenant: mockWithTenant,
}));

const { LineEventProcessor, PermanentJobError } = await import('./line-event.processor.js');

const COMPANY_ID = '11111111-1111-1111-8111-111111111111';
const ROW_ID = 'row-uuid';
const EVENT_ID = 'evt-1';
const CHANNEL_ID = '1234567890';

const PAYLOAD = {
  type: 'message',
  timestamp: 1_700_000_000_000,
  webhookEventId: EVENT_ID,
  source: { type: 'user', userId: 'U1234' },
  replyToken: 'rtok-abc',
  message: { type: 'text', id: 'm1', text: 'hi' },
};

const CHANNEL: CompanyLineChannel = {
  id: 'cccc-cccc',
  companyId: COMPANY_ID,
  channelId: CHANNEL_ID,
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

class FakeHandler {
  handle = vi.fn();
}

class FakeStateService {
  markProcessed = vi.fn();
  markFailed = vi.fn();
}

type JobShape = {
  data: {
    webhookEventRowId: string;
    companyId: string;
    channelId: string;
    eventId: string;
    eventType: string;
  };
  attemptsMade: number;
  opts: { attempts: number };
};

function makeJob(overrides?: Partial<JobShape>): Job {
  const base: JobShape = {
    data: {
      webhookEventRowId: ROW_ID,
      companyId: COMPANY_ID,
      channelId: CHANNEL_ID,
      eventId: EVENT_ID,
      eventType: 'message',
    },
    attemptsMade: 1,
    opts: { attempts: 5 },
  };
  return { ...base, ...overrides } as unknown as Job;
}

describe('LineEventProcessor', () => {
  let channelService: FakeChannelService;
  let handler: FakeHandler;
  let state: FakeStateService;
  let processor: InstanceType<typeof LineEventProcessor>;

  beforeEach(() => {
    mockFindUnique.mockReset();
    mockWithTenant.mockReset();
    mockWithTenant.mockImplementation(async (_ctx: unknown, fn: () => Promise<unknown>) => fn());

    channelService = new FakeChannelService();
    handler = new FakeHandler();
    state = new FakeStateService();

    processor = new LineEventProcessor(
      // biome-ignore lint/suspicious/noExplicitAny: structural typing across test boundary
      handler as any,
      // biome-ignore lint/suspicious/noExplicitAny: structural typing across test boundary
      channelService as any,
      // biome-ignore lint/suspicious/noExplicitAny: structural typing across test boundary
      state as any,
    );
  });

  // -----------------------------------------------------------------------
  // process — happy path
  // -----------------------------------------------------------------------

  it('hydrates the row, dispatches the event, and marks processed', async () => {
    mockFindUnique.mockResolvedValueOnce({ payload: PAYLOAD, status: 'pending' });
    channelService.findByCompanyIdUnscoped.mockResolvedValueOnce(CHANNEL);
    handler.handle.mockResolvedValueOnce(undefined);
    state.markProcessed.mockResolvedValueOnce(undefined);

    const result = await processor.process(makeJob());

    expect(result).toEqual({ ok: true });
    expect(mockWithTenant).toHaveBeenCalled();
    expect(channelService.findByCompanyIdUnscoped).toHaveBeenCalledWith(COMPANY_ID);
    expect(handler.handle).toHaveBeenCalledWith({ event: expect.any(Object), channel: CHANNEL });
    expect(state.markProcessed).toHaveBeenCalledWith({
      webhookEventRowId: ROW_ID,
      companyId: COMPANY_ID,
    });
  });

  // -----------------------------------------------------------------------
  // process — row missing (e.g. GDPR purge)
  // -----------------------------------------------------------------------

  it('returns cleanly when the WebhookEvent row is missing (no handler call)', async () => {
    mockFindUnique.mockResolvedValueOnce(null);

    const result = await processor.process(makeJob());

    expect(result).toEqual({ ok: true });
    expect(handler.handle).not.toHaveBeenCalled();
    expect(state.markProcessed).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // process — already processed (idempotent re-fire)
  // -----------------------------------------------------------------------

  it('skips the handler when the row is already processed', async () => {
    mockFindUnique.mockResolvedValueOnce({ payload: PAYLOAD, status: 'processed' });

    const result = await processor.process(makeJob());

    expect(result).toEqual({ ok: true });
    expect(handler.handle).not.toHaveBeenCalled();
    expect(state.markProcessed).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // process — invalid payload → permanent
  // -----------------------------------------------------------------------

  it('throws PermanentJobError when the persisted payload fails Zod validation', async () => {
    mockFindUnique.mockResolvedValueOnce({
      payload: { type: 'message' /* missing required fields */ },
      status: 'pending',
    });

    await expect(processor.process(makeJob())).rejects.toBeInstanceOf(PermanentJobError);
    expect(handler.handle).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // process — channel gone → permanent
  // -----------------------------------------------------------------------

  it('throws PermanentJobError when the channel disappeared between enqueue and dispatch', async () => {
    mockFindUnique.mockResolvedValueOnce({ payload: PAYLOAD, status: 'pending' });
    channelService.findByCompanyIdUnscoped.mockResolvedValueOnce(null);

    await expect(processor.process(makeJob())).rejects.toBeInstanceOf(PermanentJobError);
    expect(handler.handle).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // onFailed — transient mid-attempt → no DB write
  // -----------------------------------------------------------------------

  it('does NOT mark the row failed on a non-final transient attempt', async () => {
    const job = makeJob({ attemptsMade: 2, opts: { attempts: 5 } });
    await processor.onFailed(job, new Error('transient'));

    expect(state.markFailed).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // onFailed — exhausted attempts → mark failed
  // -----------------------------------------------------------------------

  it('marks the row failed once BullMQ exhausts all attempts', async () => {
    const job = makeJob({ attemptsMade: 5, opts: { attempts: 5 } });
    await processor.onFailed(job, new Error('still broken'));

    expect(state.markFailed).toHaveBeenCalledTimes(1);
    expect(state.markFailed).toHaveBeenCalledWith({
      webhookEventRowId: ROW_ID,
      companyId: COMPANY_ID,
      error: expect.any(Error),
      attemptsMade: 5,
    });
  });

  // -----------------------------------------------------------------------
  // onFailed — PermanentJobError → mark failed regardless of attempts
  // -----------------------------------------------------------------------

  it('marks the row failed immediately on PermanentJobError even at attempt 1', async () => {
    const job = makeJob({ attemptsMade: 1, opts: { attempts: 5 } });
    await processor.onFailed(job, new PermanentJobError('zod failure'));

    expect(state.markFailed).toHaveBeenCalledTimes(1);
    expect(state.markFailed).toHaveBeenCalledWith({
      webhookEventRowId: ROW_ID,
      companyId: COMPANY_ID,
      error: expect.any(PermanentJobError),
      attemptsMade: 1,
    });
  });
});
