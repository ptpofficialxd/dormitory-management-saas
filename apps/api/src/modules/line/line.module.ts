import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUE_NAMES } from '../../common/queue/queue-names.js';
import { CompanyLineChannelController } from './company-line-channel.controller.js';
import { CompanyLineChannelService } from './company-line-channel.service.js';
import { LineEventHandlerService } from './line-event-handler.service.js';
import { LineEventProcessor } from './line-event.processor.js';
import { LineMessagingClient } from './line-messaging.client.js';
import { LineWebhookController } from './line-webhook.controller.js';
import { LineWebhookService } from './line-webhook.service.js';
import { WebhookEventStateService } from './webhook-event-state.service.js';

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
  providers: [
    CompanyLineChannelService,
    LineWebhookService,
    // Worker chain (Task #40):
    //   LineEventProcessor   — BullMQ @Processor; one Worker spawned at boot
    //   LineEventHandlerService — switch on event.type → reply / log
    //   LineMessagingClient  — fetch wrapper for LINE Messaging API
    //   WebhookEventStateService — RLS-scoped status writes on WebhookEvent
    LineEventProcessor,
    LineEventHandlerService,
    LineMessagingClient,
    WebhookEventStateService,
  ],
  exports: [CompanyLineChannelService],
})
export class LineModule {}
