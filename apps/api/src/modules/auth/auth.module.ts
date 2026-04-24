import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtService } from './jwt.service.js';
import { LineIdTokenVerifier } from './line-id-token.verifier.js';
import { MeAuthController } from './me-auth.controller.js';

/**
 * Wires the auth controllers + services.
 *
 * `JwtService` is exported so other modules (e.g. global JwtGuard,
 * TenantInviteService for the redeem-bind first-time-token optimisation)
 * can inject it without re-instantiating the jose secret material.
 *
 * `LineIdTokenVerifier` is exported because both the bind flow
 * (TenantInviteModule) and the LIFF session flow (`POST /me/auth/exchange`)
 * verify LINE-issued idTokens. Lifted from tenant-invite into auth in
 * Task #75 to avoid a circular dep when AuthModule grew an LIFF surface.
 *
 * `AuthService` is exported so TenantInviteModule can call
 * `mintTenantSession()` to bake a fresh tenant token into its redeem
 * response — keeps the JWT-mint logic centralised here.
 */
@Module({
  controllers: [AuthController, MeAuthController],
  providers: [AuthService, JwtService, LineIdTokenVerifier],
  exports: [AuthService, JwtService, LineIdTokenVerifier],
})
export class AuthModule {}
