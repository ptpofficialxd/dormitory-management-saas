import { Module } from '@nestjs/common';
import { UnitController } from './unit.controller.js';
import { UnitService } from './unit.service.js';

@Module({
  controllers: [UnitController],
  providers: [UnitService],
  exports: [UnitService],
})
export class UnitModule {}
