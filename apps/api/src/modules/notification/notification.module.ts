import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUE_NAMES } from '../../common/queue/queue-names.js';
import { LineModule } from '../line/line.module.js';
import { LineNotificationProcessor } from './line-notification.processor.js';
import { NotificationService } from './notification.service.js';

/**
 * NotificationModule — owns the transactional 1-to-1 LINE push pipeline.
 *
 * Producers (Task #84): InvoiceService + PaymentService import this module
 * via BillingModule and inject `NotificationService` to enqueue.
 *
 * Consumers (this module): the `LineNotificationProcessor` worker is a
 * provider here — Nest spawns one BullMQ Worker per @Processor at app
 * boot, sharing the Redis connection from the global QueueModule.
 *
 * `BullModule.registerQueue({ name: LINE_NOTIFICATION })` is REQUIRED here
 * even though QueueModule already registers the same queue at app root.
 * Reason: `@InjectQueue('line-notification')` resolves the provider token
 * from the IMPORTING module's scope first, and BullModule defines per-import
 * tokens. Re-registering inside this module wires the local injection point
 * to the same Redis-backed queue (BullMQ keys are global). Same pattern as
 * LineModule + the line-webhook queue.
 *
 * `LineModule` import gives us:
 *   - `CompanyLineChannelService` (decrypt access token per company)
 *   - `LineMessagingClient` (POST /push wrapper) — exported in Task #83
 */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_NAMES.LINE_NOTIFICATION }), LineModule],
  providers: [NotificationService, LineNotificationProcessor],
  exports: [NotificationService],
})
export class NotificationModule {}
