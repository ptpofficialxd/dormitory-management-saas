import { Module } from '@nestjs/common';
import { MaintenanceController } from './maintenance.controller.js';
import { MaintenanceService } from './maintenance.service.js';
import { MeMaintenanceController } from './me-maintenance.controller.js';

/**
 * MaintenanceModule (Sprint B / Task #88).
 *
 * Wires both admin (`/c/:slug/maintenance`) and tenant (`/me/maintenance`)
 * controllers around a single `MaintenanceService`. StorageService comes
 * via the @Global() StorageModule — no explicit import needed.
 *
 * Exports `MaintenanceService` so a Phase-2 dashboard module / report
 * generator can inject it without re-importing internals. Notification
 * hooks (Task #91) will inject NotificationService into the service via
 * a constructor patch — done in that follow-up to keep this PR focused
 * on the core CRUD surface.
 */
@Module({
  controllers: [MaintenanceController, MeMaintenanceController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
