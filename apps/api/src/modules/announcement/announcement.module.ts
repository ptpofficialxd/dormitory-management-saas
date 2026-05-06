import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module.js';
import { AnnouncementController } from './announcement.controller.js';
import { AnnouncementService } from './announcement.service.js';

/**
 * AnnouncementModule — admin broadcast surface (COM-003 / Task #107).
 *
 * Imports NotificationModule to get NotificationService (which exposes
 * enqueueAnnouncementBroadcast). The actual LINE push fan-out + counter
 * bookkeeping lives in NotificationModule's worker — this module owns
 * persistence + the HTTP surface only.
 */
@Module({
  imports: [NotificationModule],
  controllers: [AnnouncementController],
  providers: [AnnouncementService],
  exports: [AnnouncementService],
})
export class AnnouncementModule {}
