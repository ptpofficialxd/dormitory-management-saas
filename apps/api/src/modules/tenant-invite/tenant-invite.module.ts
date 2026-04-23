import { Module } from '@nestjs/common';
import { LineIdTokenVerifier } from './line-id-token.verifier.js';
import {
  AdminTenantInviteController,
  PublicTenantInviteController,
} from './tenant-invite.controller.js';
import { TenantInviteService } from './tenant-invite.service.js';

/**
 * TenantInviteModule (Task #41) — wires the admin generate / list / revoke
 * surface alongside the public LIFF peek / redeem surface.
 *
 * Both controllers share `TenantInviteService`. `LineIdTokenVerifier` is
 * scoped to this module because nothing else in the app verifies LINE
 * idTokens today; if the LIFF tenant dashboard adds idToken-protected
 * endpoints later, lift the verifier into a dedicated `LiffAuthModule`
 * with `@Global()`.
 */
@Module({
  controllers: [AdminTenantInviteController, PublicTenantInviteController],
  providers: [TenantInviteService, LineIdTokenVerifier],
  exports: [TenantInviteService],
})
export class TenantInviteModule {}
