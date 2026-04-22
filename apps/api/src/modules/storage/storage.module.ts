import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service.js';

/**
 * `@Global()` so Slip / Reading / Tenant modules can inject `StorageService`
 * without importing StorageModule explicitly. Single S3Client instance per
 * process keeps the HTTP keep-alive pool warm.
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
