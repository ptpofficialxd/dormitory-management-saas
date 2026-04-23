import type { CompanyLineChannel, LineWebhookEvent } from '@dorm/shared/zod';
import { type MockInstance, beforeEach, describe, expect, it, vi } from 'vitest';
import { LineEventHandlerService } from './line-event-handler.service.js';
import {
  LineMessagingClient,
  LineMessagingClientError,
  LineMessagingPermanentError,
  type LineOutboundMessage,
} from './line-messaging.client.js';

/**
 * Captured call-arg shape for `replyMessage` / `pushMessage`. Mirrors the
 * private `ReplyArgs` / `PushArgs` from line-messaging.client.ts (which
 * aren't exported — the spy's `mock.calls[0]?.[0]` is `unknown` because we
 * use an untyped `MockInstance` per the codebase's established pattern,
 * see invoice.service.test.ts).
 */
type CapturedReplyArgs = {
  replyToken: string;
  messages: LineOutboundMessage[];
  accessToken: string;
};

/**
 * Unit tests for `LineEventHandlerService` — the dispatcher.
 *
 *   - message + replyToken     → reply text contains LIFF link, calls
 *                                  messaging.replyMessage with the channel
 *                                  access token
 *   - message - replyToken     → no API call (no quota burn)
 *   - follow + replyToken      → reply text contains LIFF link
 *   - unfollow / postback /
 *     unknown                  → no API call (log-only)
 *   - permanent error from
 *     LINE                     → swallowed (worker job ends OK)
 *   - transient error from
 *     LINE                     → re-thrown so BullMQ retries
 */

const COMPANY_ID = '11111111-1111-1111-8111-111111111111';
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

function makeMessageEvent(opts: { withReplyToken?: boolean }): LineWebhookEvent {
  return {
    type: 'message',
    timestamp: 1_700_000_000_000,
    webhookEventId: 'evt-1',
    source: { type: 'user', userId: 'U1234' },
    replyToken: opts.withReplyToken ? 'rtok-abc' : undefined,
    message: { type: 'text', id: 'm1', text: 'hi' },
  } as unknown as LineWebhookEvent;
}

function makeFollowEvent(opts: { withReplyToken?: boolean }): LineWebhookEvent {
  return {
    type: 'follow',
    timestamp: 1_700_000_000_000,
    webhookEventId: 'evt-2',
    source: { type: 'user', userId: 'U1234' },
    replyToken: opts.withReplyToken ? 'rtok-foll' : undefined,
  } as unknown as LineWebhookEvent;
}

describe('LineEventHandlerService', () => {
  let messaging: LineMessagingClient;
  // Untyped `MockInstance` mirrors invoice.service.test.ts — vi.spyOn's
  // `MethodKeysOf<T>` generic doesn't compose cleanly when the source class
  // is loaded via dynamic import; the default `Procedure` signature is fine
  // for our assertions (we cast `mock.calls[0]?.[0]` to `CapturedReplyArgs`).
  let replySpy: MockInstance;
  let pushSpy: MockInstance;
  let service: LineEventHandlerService;

  beforeEach(() => {
    messaging = new LineMessagingClient();
    replySpy = vi.spyOn(messaging, 'replyMessage').mockResolvedValue(undefined);
    pushSpy = vi.spyOn(messaging, 'pushMessage').mockResolvedValue(undefined);
    service = new LineEventHandlerService(messaging);
  });

  // -----------------------------------------------------------------------
  // message
  // -----------------------------------------------------------------------

  it('replies with canned help text + LIFF link on message events with replyToken', async () => {
    const event = makeMessageEvent({ withReplyToken: true });
    await service.handle({ event, channel: CHANNEL });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).not.toHaveBeenCalled();
    const arg = replySpy.mock.calls[0]?.[0] as CapturedReplyArgs;
    expect(arg.replyToken).toBe('rtok-abc');
    expect(arg.accessToken).toBe(CHANNEL.channelAccessToken);
    expect(arg.messages).toHaveLength(1);
    expect(arg.messages[0]?.type).toBe('text');
    expect(arg.messages[0]?.text).toContain('liff.line.me');
    expect(arg.messages[0]?.text).toContain(`company=${COMPANY_ID}`);
  });

  it('skips reply (no quota burn) when message arrives without replyToken', async () => {
    const event = makeMessageEvent({ withReplyToken: false });
    await service.handle({ event, channel: CHANNEL });

    expect(replySpy).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // follow
  // -----------------------------------------------------------------------

  it('replies with welcome + LIFF link on follow with replyToken', async () => {
    const event = makeFollowEvent({ withReplyToken: true });
    await service.handle({ event, channel: CHANNEL });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const arg = replySpy.mock.calls[0]?.[0] as CapturedReplyArgs;
    expect(arg.replyToken).toBe('rtok-foll');
    expect(arg.messages[0]?.text).toContain('ยินดีต้อนรับ');
    expect(arg.messages[0]?.text).toContain('liff.line.me');
  });

  it('skips welcome when follow arrives without replyToken', async () => {
    const event = makeFollowEvent({ withReplyToken: false });
    await service.handle({ event, channel: CHANNEL });

    expect(replySpy).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // unfollow / postback / unknown
  // -----------------------------------------------------------------------

  it('does not call LINE on unfollow (log-only)', async () => {
    const event = {
      type: 'unfollow',
      timestamp: 1_700_000_000_000,
      source: { type: 'user', userId: 'U1234' },
    } as unknown as LineWebhookEvent;

    await service.handle({ event, channel: CHANNEL });

    expect(replySpy).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('does not call LINE on postback (log-only)', async () => {
    const event = {
      type: 'postback',
      timestamp: 1_700_000_000_000,
      source: { type: 'user', userId: 'U1234' },
      replyToken: 'rtok-pb',
      postback: { data: 'action=pay&invoice=123' },
    } as unknown as LineWebhookEvent;

    await service.handle({ event, channel: CHANNEL });

    expect(replySpy).not.toHaveBeenCalled();
  });

  it('does not call LINE on unknown event types (ack-only)', async () => {
    const event = {
      type: 'beacon',
      timestamp: 1_700_000_000_000,
      source: { type: 'user', userId: 'U1234' },
    } as unknown as LineWebhookEvent;

    await service.handle({ event, channel: CHANNEL });

    expect(replySpy).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Error handling — permanent vs transient
  // -----------------------------------------------------------------------

  it('swallows LineMessagingPermanentError (4xx) so BullMQ does not retry', async () => {
    replySpy.mockRejectedValueOnce(
      new LineMessagingPermanentError(
        'Invalid reply token',
        400,
        '{"message":"Invalid reply token"}',
      ),
    );
    const event = makeMessageEvent({ withReplyToken: true });

    await expect(service.handle({ event, channel: CHANNEL })).resolves.toBeUndefined();
  });

  it('rethrows transient LineMessagingClientError so BullMQ retries', async () => {
    replySpy.mockRejectedValueOnce(new LineMessagingClientError('upstream 502'));
    const event = makeMessageEvent({ withReplyToken: true });

    await expect(service.handle({ event, channel: CHANNEL })).rejects.toBeInstanceOf(
      LineMessagingClientError,
    );
  });
});
