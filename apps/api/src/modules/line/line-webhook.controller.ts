import { LINE_SIGNATURE_HEADER } from '@dorm/shared/zod';
import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../common/decorators/public.decorator.js';
import { LineWebhookService } from './line-webhook.service.js';

/**
 * Public LINE Messaging API webhook endpoint.
 *
 *   POST /line/webhook/:companySlug
 *
 * Why slug-scoped (not channel-id-scoped):
 *   - The slug is what the admin pastes into LINE Developers console as
 *     the webhook URL. It's stable across channelId rotations + readable.
 *   - We resolve `slug → companyId + channel` server-side under bypass-RLS.
 *   - LINE's `destination` field also carries the channelId for cross-check
 *     (see service-level Zod validation).
 *
 * `@Public()` skips JwtGuard — LINE doesn't carry our JWT. Auth here is
 * the X-Line-Signature HMAC, verified inside the service. PathCompanyGuard
 * is a no-op when there is no `req.user` (Public route), so the slug param
 * doesn't trip the JWT-vs-URL mismatch check.
 *
 * The Fastify `contentTypeParser` registered in `main.ts` preserves the
 * raw request body on `req.rawBody` SPECIFICALLY for paths under
 * `/line/webhook/`. Re-stringifying the parsed JSON would invalidate the
 * HMAC (key order, whitespace), so we read the buffer here and pass it
 * straight to the service. If `rawBody` is missing it means the parser
 * misfired — fail loud (500) so we notice in dev rather than ack with
 * "valid HMAC" by coincidence.
 *
 * Returns HTTP 200 on:
 *   - Successful HMAC + valid body (any mix of new + duplicate events).
 *   - Empty events[] (LINE Verify ping).
 *
 * Returns:
 *   - 401 on signature mismatch  → LineWebhookService throws Unauthorized
 *   - 400 on malformed body      → LineWebhookService throws BadRequest
 *   - 404 on unknown slug        → LineWebhookService throws NotFound
 *   - 500 on rawBody missing     → controller-level guard below
 *
 * LINE retries on any non-2xx for ~24h; 4xx will eventually be dropped on
 * their side, 5xx keeps retrying indefinitely (within the 24h window).
 */
@Controller('line/webhook')
export class LineWebhookController {
  private readonly logger = new Logger(LineWebhookController.name);

  constructor(private readonly webhookService: LineWebhookService) {}

  @Post(':companySlug')
  @Public()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Param('companySlug') companySlug: string,
    @Req() req: FastifyRequest & { rawBody?: Buffer },
    @Headers(LINE_SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<{ ok: true; processed: number; deduped: number }> {
    const rawBody = req.rawBody;
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      // The contentTypeParser in main.ts MUST stamp rawBody on every
      // /line/webhook/* request. If it didn't, signature verification is
      // impossible — fail loud rather than silently bypass auth.
      this.logger.error(
        `LINE webhook for '${companySlug}' arrived without rawBody — Fastify contentTypeParser likely misconfigured`,
      );
      throw new InternalServerErrorException({
        error: 'RawBodyMissing',
        message: 'Webhook raw body was not captured — server misconfiguration',
      });
    }

    return this.webhookService.handleWebhook({
      companySlug,
      rawBody,
      signatureHeader: signature,
    });
  }
}
