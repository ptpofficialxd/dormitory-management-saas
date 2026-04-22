import { Global, Module } from '@nestjs/common';
import { PiiCryptoService } from './pii-crypto.service.js';

/**
 * Crypto helpers shared across feature modules. Marked `@Global()` so any
 * module can `inject(PiiCryptoService)` without re-importing this module —
 * the service is stateless (key from env) and there's no benefit to scoping it.
 */
@Global()
@Module({
  providers: [PiiCryptoService],
  exports: [PiiCryptoService],
})
export class CryptoModule {}
