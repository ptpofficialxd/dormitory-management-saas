import { Injectable, Logger } from '@nestjs/common';

/**
 * Thin wrapper over the LINE Messaging API surface the worker needs.
 *
 * Currently exposes:
 *   - `replyMessage` — POST /v2/bot/message/reply (free; 1-min token TTL)
 *   - `pushMessage`  — POST /v2/bot/message/push  (counted against quota)
 *
 * Reply tokens are single-use and expire ~60s after the originating event.
 * The worker uses reply where possible (no quota cost, faster) and falls
 * back to push only when:
 *   - The originating event had no reply token (e.g. unfollow / postback
 *     without one), OR
 *   - Reply attempt returned 400 "Invalid reply token" (token already used
 *     or expired — common after a BullMQ retry).
 *
 * Error categorisation (the worker depends on these):
 *
 *   `LineMessagingClientError`   — transport / 5xx / timeout — RETRYABLE
 *   `LineMessagingPermanentError` — 4xx response from LINE — DO NOT RETRY
 *
 * The dispatcher catches `LineMessagingPermanentError` and absorbs it into
 * the WebhookEvent's `processingError` so the job ends `processed` (we did
 * what we could) rather than thrashing through 5 BullMQ attempts on a dead
 * reply token.
 *
 * Implementation notes:
 *   - Uses native `fetch` (Node ≥ 18 + Bun) per ADR-0006 — no node-fetch.
 *   - 8s `AbortController` timeout. LINE's API is normally <500ms but a
 *     stuck connection should not pin a worker thread.
 *   - Body responses are parsed defensively — LINE returns JSON on error
 *     bodies but we tolerate empty / non-JSON.
 *   - Bearer token is the per-channel access token decrypted at the
 *     resolution boundary; never logged.
 */

const LINE_API_BASE = 'https://api.line.me' as const;
const REQUEST_TIMEOUT_MS = 8_000 as const;

/**
 * LINE message envelope. We intentionally support only `text` in MVP — adding
 * sticker/template/flex later means widening this union.
 */
export type LineOutboundMessage = {
  type: 'text';
  /** LINE caps text payloads at 5 000 chars per message. */
  text: string;
};

/**
 * Caller-supplied opts. `accessToken` is per-tenant — never read from env.
 */
type ReplyArgs = {
  replyToken: string;
  messages: LineOutboundMessage[];
  accessToken: string;
};

type PushArgs = {
  to: string;
  messages: LineOutboundMessage[];
  accessToken: string;
};

/** Transport / 5xx — retry. */
export class LineMessagingClientError extends Error {
  constructor(
    message: string,
    // `Error.cause` exists since ES2022 — `override` is required by our
    // `noImplicitOverride` tsconfig. We mirror it as `readonly` to lock
    // post-construction mutation. TS modifier order: override → readonly.
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LineMessagingClientError';
  }
}

/**
 * 4xx from LINE — permanent. Caller MUST NOT retry. Includes the LINE-side
 * status + body for forensics; the worker writes it into `processingError`.
 */
export class LineMessagingPermanentError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'LineMessagingPermanentError';
  }
}

@Injectable()
export class LineMessagingClient {
  private readonly logger = new Logger(LineMessagingClient.name);

  /**
   * Send a reply using the short-lived reply token. Free of quota cost.
   * Throws `LineMessagingPermanentError` on 4xx (token expired/used,
   * malformed payload) so the worker can swallow the failure without
   * burning retries.
   */
  async replyMessage(args: ReplyArgs): Promise<void> {
    const { replyToken, messages, accessToken } = args;
    await this.postJson(
      `${LINE_API_BASE}/v2/bot/message/reply`,
      { replyToken, messages },
      accessToken,
    );
  }

  /**
   * Push a message to a userId. Counts against the channel's monthly quota.
   * Used as fallback when reply tokens are unavailable / expired.
   */
  async pushMessage(args: PushArgs): Promise<void> {
    const { to, messages, accessToken } = args;
    await this.postJson(`${LINE_API_BASE}/v2/bot/message/push`, { to, messages }, accessToken);
  }

  /**
   * Internal HTTP helper. Centralises auth header, timeout, and the
   * permanent-vs-transient error mapping.
   */
  private async postJson(url: string, body: unknown, accessToken: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Network / DNS / abort — RETRYABLE. We do NOT log the access token.
      throw new LineMessagingClientError(
        `LINE API request to ${url} failed: ${(err as Error).message}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) return;

    // Read body for diagnostics. LINE returns small JSON envelopes on error;
    // we cap to avoid pulling huge HTML error pages into log lines.
    const responseBody = await safeReadBody(response);
    const status = response.status;

    if (status >= 400 && status < 500) {
      // 4xx is permanent — invalid payload, expired token, no quota left,
      // recipient blocked the OA, etc. Worker absorbs and marks processed.
      throw new LineMessagingPermanentError(
        `LINE API ${status} on ${url}: ${responseBody}`,
        status,
        responseBody,
      );
    }

    // 5xx + anything else — retryable.
    throw new LineMessagingClientError(`LINE API ${status} on ${url}: ${responseBody}`);
  }
}

/**
 * Read up to 1 KiB of response body for logging. Never throws — falls back to
 * an empty string. Avoids pulling megabytes if LINE ever returns an HTML page.
 */
async function safeReadBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 1024 ? `${text.slice(0, 1024)}…[truncated]` : text;
  } catch {
    return '';
  }
}
