import { Module } from '@nestjs/common';
import { MeterController } from './meter.controller.js';
import { MeterService } from './meter.service.js';

@Module({
  controllers: [MeterController],
  providers: [MeterService],
  exports: [MeterService],
})
export class MeterModule {}
