import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import {
  AdminTenantInviteController,
  PublicTenantInviteController,
} from './tenant-invite.controller.js';
import { TenantInviteService } from './tenant-invite.service.js';

/**
 * TenantInviteModule (Task #41) — wires the admin generate / list / revoke
 * surface alongside the public LIFF peek / redeem surface.
 *
 * Both controllers share `TenantInviteService`. `LineIdTokenVerifier` lives
 * in `AuthModule` (lifted there in Task #75 because LIFF tenant routes also
 * need it for `POST /me/auth/exchange`); we just import AuthModule to access
 * it via DI.
 *
 * AuthModule also exports `JwtService`, which the redeem flow needs to mint
 * a tenant JWT in the redeem response (first-time-bind UX optimisation —
 * see `RedeemTenantInviteResponse.token`).
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminTenantInviteController, PublicTenantInviteController],
  providers: [TenantInviteService],
  exports: [TenantInviteService],
})
export class TenantInviteModule {}
