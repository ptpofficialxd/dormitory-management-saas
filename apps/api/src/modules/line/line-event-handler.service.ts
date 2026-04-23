import type {
  CompanyLineChannel,
  LineFollowEvent,
  LineMessageEvent,
  LinePostbackEvent,
  LineUnfollowEvent,
  LineWebhookEvent,
} from '@dorm/shared/zod';
import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../config/env.js';
import {
  LineMessagingClient,
  LineMessagingPermanentError,
  type LineOutboundMessage,
} from './line-messaging.client.js';

/**
 * Dispatcher for hydrated LINE webhook events. Called by the BullMQ
 * processor with:
 *   - the parsed `LineWebhookEvent` (read from `WebhookEvent.payload`)
 *   - the per-tenant `CompanyLineChannel` (decrypted secrets — used for
 *     the per-channel access token when calling Reply / Push)
 *
 * MVP behaviour (per Task #40 design — recommended-track answers):
 *
 *   message    →  Canned reply: short Thai help text + LIFF binding link
 *   follow     →  Welcome reply: Thai welcome text + LIFF binding link
 *   unfollow   →  Log only (Phase 2: flag tenant.optedOut)
 *   postback   →  Log only (Phase 2: rich-menu actions)
 *   unknown    →  Log + ack
 *
 * Why we keep handlers tiny here:
 *   The dispatcher is the only place we touch LINE outbound messaging from
 *   the worker side. Real business logic (binding flow, command parsing,
 *   ticket creation) belongs in dedicated services that we'll plug in via
 *   DI in Task #41+. Today's responsibility is "ack the webhook + give the
 *   tenant a path forward (LIFF link)".
 *
 * Permanent-error handling:
 *   `LineMessagingPermanentError` (4xx from LINE — expired reply token, etc.)
 *   is caught + logged + swallowed. The worker's job still completes; the
 *   WebhookEvent will be marked `processed` because we did our best. The
 *   alternative (rethrow) would burn 5 BullMQ retries for nothing.
 *
 *   Transient errors (`LineMessagingClientError`, anything else) ARE rethrown
 *   so BullMQ retries with the configured exponential backoff.
 */
@Injectable()
export class LineEventHandlerService {
  private readonly logger = new Logger(LineEventHandlerService.name);

  constructor(private readonly messaging: LineMessagingClient) {}

  /**
   * Single entrypoint — switches on `event.type`. The processor calls this
   * for every job; we own the dispatch table here so adding a new event
   * type means one branch + one method, not a new BullMQ worker.
   */
  async handle(args: { event: LineWebhookEvent; channel: CompanyLineChannel }): Promise<void> {
    const { event, channel } = args;

    // The Zod schema is `z.union(...)` (not `discriminatedUnion`) because the
    // `unknownEvent` branch keeps `type: z.string()` for forward-compat with
    // unreleased LINE event kinds. That makes TS's switch-narrowing impotent
    // — `event.type === 'message'` still includes the unknown branch — so we
    // hand-cast to the narrow type after the runtime discriminator. Safe
    // because the schema parsed `event` upstream and the literals match.
    switch (event.type) {
      case 'message':
        await this.handleMessage(event as LineMessageEvent, channel);
        return;
      case 'follow':
        await this.handleFollow(event as LineFollowEvent, channel);
        return;
      case 'unfollow':
        this.handleUnfollow(event as LineUnfollowEvent, channel);
        return;
      case 'postback':
        this.handlePostback(event as LinePostbackEvent, channel);
        return;
      default:
        this.handleUnknown(event, channel);
        return;
    }
  }

  // ---------------------------------------------------------------------
  // message — canned help reply + LIFF link
  // ---------------------------------------------------------------------

  private async handleMessage(event: LineMessageEvent, channel: CompanyLineChannel): Promise<void> {
    // No reply token → either old/redelivered event OR group/room message
    // without one. Skip silently (no quota burn on push to a group).
    if (!event.replyToken) {
      this.logger.debug(
        `message event for company=${channel.companyId} arrived without replyToken — skipping reply`,
      );
      return;
    }

    const liffUrl = buildLiffBindUrl(channel.companyId);
    const cannedText = `สวัสดีครับ 🙌 ระบบยังไม่ได้ผูกห้องของคุณกับบัญชี LINE นี้\nกดลิงก์ด้านล่างเพื่อเปิดหน้าผูกบัญชีในแอปได้เลยครับ:\n${liffUrl}`;

    await this.tryReply({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: cannedText }],
      accessToken: channel.channelAccessToken,
      label: 'message-canned-help',
      companyId: channel.companyId,
    });
  }

  // ---------------------------------------------------------------------
  // follow — welcome message + LIFF link
  // ---------------------------------------------------------------------

  private async handleFollow(event: LineFollowEvent, channel: CompanyLineChannel): Promise<void> {
    if (!event.replyToken) {
      this.logger.debug(
        `follow event for company=${channel.companyId} arrived without replyToken — skipping welcome`,
      );
      return;
    }

    const liffUrl = buildLiffBindUrl(channel.companyId);
    const welcome = `ยินดีต้อนรับเข้าสู่หอพัก 🏠\nกดลิงก์ด้านล่างเพื่อเปิดหน้าผูกบัญชี LINE กับห้องของคุณ:\n${liffUrl}`;

    await this.tryReply({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: welcome }],
      accessToken: channel.channelAccessToken,
      label: 'follow-welcome',
      companyId: channel.companyId,
    });
  }

  // ---------------------------------------------------------------------
  // unfollow / postback / unknown — log-only branches (Phase 2 expand)
  // ---------------------------------------------------------------------

  private handleUnfollow(event: LineUnfollowEvent, channel: CompanyLineChannel): void {
    // No reply allowed on unfollow — LINE strips the reply token. Log so we
    // can build a tenant.optedOut flag in Phase 2.
    this.logger.log(
      `unfollow received company=${channel.companyId} source=${JSON.stringify(event.source)} — Phase 2 will set tenant.optedOut`,
    );
  }

  private handlePostback(event: LinePostbackEvent, channel: CompanyLineChannel): void {
    // Phase 2: parse `event.postback.data` and route to the right service
    // (rich-menu pay/maintenance actions). For MVP we just log so we can
    // see what data shapes the OA admin configures.
    this.logger.log(
      `postback received company=${channel.companyId} data=${event.postback.data} — Phase 2 dispatch pending`,
    );
  }

  private handleUnknown(event: LineWebhookEvent, channel: CompanyLineChannel): void {
    this.logger.log(
      `unhandled LINE event type='${event.type}' company=${channel.companyId} — ack-only`,
    );
  }

  // ---------------------------------------------------------------------
  // Internal: reply with permanent-error swallow + transient rethrow
  // ---------------------------------------------------------------------

  private async tryReply(args: {
    replyToken: string;
    messages: LineOutboundMessage[];
    accessToken: string;
    label: string;
    companyId: string;
  }): Promise<void> {
    const { replyToken, messages, accessToken, label, companyId } = args;
    try {
      await this.messaging.replyMessage({ replyToken, messages, accessToken });
    } catch (err) {
      if (err instanceof LineMessagingPermanentError) {
        // 4xx — expired token / quota / blocked recipient. Worker keeps
        // going; we don't want to retry into a brick wall.
        this.logger.warn(
          `LINE reply '${label}' rejected (status=${err.status}) for company=${companyId}: ${err.body}`,
        );
        return;
      }
      // Anything else — let BullMQ retry with backoff.
      throw err;
    }
  }
}

/**
 * Build the LIFF deep-link the OA hands tenants on follow / first message.
 * Includes `?company=<companyId>` so the LIFF page can pre-select the right
 * tenant scope (saves the user a step). The LIFF app reads `liff.state`
 * (URL-encoded) at startup and forwards into the binding flow.
 */
function buildLiffBindUrl(companyId: string): string {
  const base = env.LIFF_BIND_URL;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}company=${encodeURIComponent(companyId)}`;
}
