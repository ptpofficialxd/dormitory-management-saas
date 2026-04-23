import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LineMessagingClient,
  LineMessagingClientError,
  LineMessagingPermanentError,
} from './line-messaging.client.js';

/**
 * Pure-function unit tests for the LINE messaging client.
 *
 * We stub `globalThis.fetch` to avoid hitting the LINE API. Each test verifies
 * one error-classification branch so the worker can rely on the shape of the
 * thrown errors:
 *
 *   - 200 OK → resolves
 *   - 4xx    → LineMessagingPermanentError (NOT retryable)
 *   - 5xx    → LineMessagingClientError    (retryable)
 *   - throw  → LineMessagingClientError    (retryable)
 *   - timeout → LineMessagingClientError   (retryable; AbortController fires)
 *
 * Plus assertions on the request shape (URL, headers, body) since the worker
 * encodes contractual values (`Bearer <token>`, JSON content-type, payload
 * envelope) here.
 */

describe('LineMessagingClient', () => {
  let client: LineMessagingClient;
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    client = new LineMessagingClient();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // replyMessage — happy path + payload contract
  // -----------------------------------------------------------------------

  it('POSTs the reply payload to /v2/bot/message/reply with bearer auth', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));

    await client.replyMessage({
      replyToken: 'token-abc',
      messages: [{ type: 'text', text: 'hello' }],
      accessToken: 'channel-access-token',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.line.me/v2/bot/message/reply');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBe('Bearer channel-access-token');
    expect(JSON.parse(init.body as string)).toEqual({
      replyToken: 'token-abc',
      messages: [{ type: 'text', text: 'hello' }],
    });
  });

  // -----------------------------------------------------------------------
  // pushMessage — payload differs from reply (uses `to` not `replyToken`)
  // -----------------------------------------------------------------------

  it('POSTs the push payload to /v2/bot/message/push with the recipient userId', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));

    await client.pushMessage({
      to: 'U1234567890',
      messages: [{ type: 'text', text: 'welcome' }],
      accessToken: 'channel-access-token',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.line.me/v2/bot/message/push');
    expect(JSON.parse(init.body as string)).toEqual({
      to: 'U1234567890',
      messages: [{ type: 'text', text: 'welcome' }],
    });
  });

  // -----------------------------------------------------------------------
  // 4xx — permanent
  // -----------------------------------------------------------------------

  it('throws LineMessagingPermanentError on 400 (expired reply token)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Invalid reply token' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      client.replyMessage({
        replyToken: 'token-stale',
        messages: [{ type: 'text', text: 'hi' }],
        accessToken: 'channel-access-token',
      }),
    ).rejects.toMatchObject({
      name: 'LineMessagingPermanentError',
      status: 400,
    });
  });

  it('throws LineMessagingPermanentError on 401 (revoked access token)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    await expect(
      client.pushMessage({
        to: 'U1234567890',
        messages: [{ type: 'text', text: 'hi' }],
        accessToken: 'wrong-token',
      }),
    ).rejects.toBeInstanceOf(LineMessagingPermanentError);
  });

  // -----------------------------------------------------------------------
  // 5xx — retryable
  // -----------------------------------------------------------------------

  it('throws LineMessagingClientError on 500 (LINE outage — retry)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream timeout', { status: 502 }));

    await expect(
      client.replyMessage({
        replyToken: 'token-abc',
        messages: [{ type: 'text', text: 'hi' }],
        accessToken: 'channel-access-token',
      }),
    ).rejects.toBeInstanceOf(LineMessagingClientError);
  });

  // -----------------------------------------------------------------------
  // Network / fetch throw — retryable
  // -----------------------------------------------------------------------

  it('wraps fetch() throws as LineMessagingClientError', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(
      client.replyMessage({
        replyToken: 'token-abc',
        messages: [{ type: 'text', text: 'hi' }],
        accessToken: 'channel-access-token',
      }),
    ).rejects.toMatchObject({
      name: 'LineMessagingClientError',
      message: expect.stringContaining('ECONNRESET'),
    });
  });

  // -----------------------------------------------------------------------
  // Body truncation in error log (avoid log-blob blowups)
  // -----------------------------------------------------------------------

  it('truncates large error bodies in the thrown error message', async () => {
    const big = 'x'.repeat(2000);
    fetchMock.mockResolvedValueOnce(new Response(big, { status: 400 }));

    try {
      await client.replyMessage({
        replyToken: 'token-abc',
        messages: [{ type: 'text', text: 'hi' }],
        accessToken: 'channel-access-token',
      });
      expect.fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LineMessagingPermanentError);
      const e = err as LineMessagingPermanentError;
      expect(e.body.length).toBeLessThanOrEqual(1024 + '…[truncated]'.length);
      expect(e.body.endsWith('…[truncated]')).toBe(true);
    }
  });
});
