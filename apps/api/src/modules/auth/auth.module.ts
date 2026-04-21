import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtService } from './jwt.service.js';

/**
 * Wires the auth controller + services. `JwtService` is exported so other
 * modules (e.g. global JwtGuard) can inject it without re-instantiating the
 * jose secret material.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, JwtService],
  exports: [JwtService],
})
export class AuthModule {}
