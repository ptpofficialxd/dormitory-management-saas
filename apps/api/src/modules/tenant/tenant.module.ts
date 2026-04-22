import { Module } from '@nestjs/common';
import { TenantController } from './tenant.controller.js';
import { TenantService } from './tenant.service.js';

/**
 * `PiiCryptoService` is provided by the `@Global() CryptoModule` registered
 * once in AppModule, so we don't need to re-import it here.
 */
@Module({
  controllers: [TenantController],
  providers: [TenantService],
  exports: [TenantService],
})
export class TenantModule {}
