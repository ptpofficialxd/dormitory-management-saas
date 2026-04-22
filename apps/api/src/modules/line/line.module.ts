import { Module } from '@nestjs/common';
import { CompanyLineChannelController } from './company-line-channel.controller.js';
import { CompanyLineChannelService } from './company-line-channel.service.js';

/**
 * LineModule — owns LINE OA configuration (this file) and will host the
 * webhook controller (Task #37).
 *
 * `CompanyLineChannelService` is exported so the upcoming `LineWebhookController`
 * can call `findByChannelIdUnscoped(channelId)` during signature verification.
 *
 * `PiiCryptoService` is provided by the `@Global() CryptoModule` registered
 * once in AppModule, so we don't re-import it here.
 *
 * Not @Global — only LINE-related code should reach for these services.
 */
@Module({
  controllers: [CompanyLineChannelController],
  providers: [CompanyLineChannelService],
  exports: [CompanyLineChannelService],
})
export class LineModule {}
