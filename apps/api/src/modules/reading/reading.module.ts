import { Module } from '@nestjs/common';
import { ReadingController } from './reading.controller.js';
import { ReadingService } from './reading.service.js';

@Module({
  controllers: [ReadingController],
  providers: [ReadingService],
  exports: [ReadingService],
})
export class ReadingModule {}
