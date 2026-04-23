import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUE_NAMES } from '../../common/queue/queue-names.js';
import { CompanyLineChannelController } from './company-line-channel.controller.js';
import { CompanyLineChannelService } from './company-line-channel.service.js';
import { LineWebhookController } from './line-webhook.controller.js';
import { LineWebhookService } from './line-webhook.service.js';

/**
 * LineModule — owns LINE OA configuration + the inbound webhook surface.
 *
 *   Admin path (auth-protected):
 *     CompanyLineChannelController + CompanyLineChannelService
 *       — CRUD per-tenant channel credentials
 *
 *   Public webhook path (HMAC-protected):
 *     LineWebhookController + LineWebhookService
 *       — POST /line/webhook/:companySlug
 *
 * `BullModule.registerQueue({ name: LINE_WEBHOOK })` is REQUIRED here even
 * though `QueueModule` already registers the same queue at the app root.
 * Reason: `@InjectQueue('line-webhook')` resolves the provider token from
 * the IMPORTING module's scope first, and `BullModule` defines per-import
 * tokens. Re-registering inside this module wires the local injection
 * point to the same Redis-backed queue (BullMQ keys are global).
 *
 * `PiiCryptoService` (used by CompanyLineChannelService) comes from the
 * `@Global() CryptoModule` registered in AppModule — not re-imported here.
 *
 * `CompanyLineChannelService` is exported because `LineWebhookService`
 * uses it AND it's referenced by upstream tests directly.
 */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_NAMES.LINE_WEBHOOK })],
  controllers: [CompanyLineChannelController, LineWebhookController],
  providers: [CompanyLineChannelService, LineWebhookService],
  exports: [CompanyLineChannelService],
})
export class LineModule {}
