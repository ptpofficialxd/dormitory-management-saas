import type { AdminJwtClaims } from '@dorm/shared/zod';
import {
  type GenerateTenantInviteInput,
  type GenerateTenantInviteResponse,
  type ListTenantInvitesQuery,
  type PeekTenantInviteInput,
  type RedeemTenantInviteInput,
  type RedeemTenantInviteResponse,
  type RevokeTenantInviteInput,
  type TenantInvite,
  type TenantInvitePreview,
  generateTenantInviteInputSchema,
  listTenantInvitesQuerySchema,
  peekTenantInviteInputSchema,
  redeemTenantInviteInputSchema,
  revokeTenantInviteInputSchema,
} from '@dorm/shared/zod';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Perm } from '../../common/decorators/perm.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { ZodBody, ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { LineIdTokenVerifier } from './line-id-token.verifier.js';
import { TenantInviteService } from './tenant-invite.service.js';

/**
 * TenantInvite endpoints split across TWO controllers in this file:
 *
 *   AdminTenantInviteController  → `/c/:companySlug/...`
 *     - JWT-protected, RLS-scoped via TenantContextInterceptor
 *     - Roles: company_owner, property_manager, staff
 *
 *   PublicTenantInviteController → `/liff/invites/...`
 *     - `@Public()` (no JWT) — LIFF runs in the user's LINE in-app browser
 *     - Identity proof = LINE idToken verified server-side per request
 *     - Service layer opens its own withTenant({companyId}) scope after
 *       resolving the invite (no admin context exists)
 *
 * Why two controllers, not one?
 *   Different base paths (`/c/:slug` vs `/liff`) + opposite auth requirements
 *   make a single controller class noisy with per-method `@Public()` flags
 *   and conditional path prefixes.
 */

@Controller('c/:companySlug')
export class AdminTenantInviteController {
  constructor(private readonly invites: TenantInviteService) {}

  /**
   * `POST /c/:slug/tenants/:tenantId/invites` — admin mints a fresh invite.
   * Returns the plaintext code ONCE (admin must save it before navigating
   * away). Subsequent reads do not include plaintext.
   */
  @Post('tenants/:tenantId/invites')
  @HttpCode(201)
  @Perm('create', 'tenant_user')
  generate(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @ZodBody(generateTenantInviteInputSchema) _body: GenerateTenantInviteInput,
    @CurrentUser() user: AdminJwtClaims,
  ): Promise<GenerateTenantInviteResponse> {
    return this.invites.generate(tenantId, user.sub);
  }

  /**
   * `GET /c/:slug/tenants/:tenantId/invites` — admin list of invites for a
   * tenant. Cursor-paginated, optional status filter.
   */
  @Get('tenants/:tenantId/invites')
  @Perm('read', 'tenant_user')
  list(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @ZodQuery(listTenantInvitesQuerySchema) query: ListTenantInvitesQuery,
  ): Promise<CursorPage<TenantInvite>> {
    return this.invites.list(tenantId, query);
  }

  /**
   * `POST /c/:slug/tenant-invites/:id/revoke` — admin invalidates a pending
   * invite (e.g. tenant lost the code). 410 Gone if not pending.
   */
  @Post('tenant-invites/:id/revoke')
  @HttpCode(200)
  @Perm('delete', 'tenant_user')
  revoke(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ZodBody(revokeTenantInviteInputSchema) body: RevokeTenantInviteInput,
    @CurrentUser() user: AdminJwtClaims,
  ): Promise<TenantInvite> {
    return this.invites.revoke(id, body, user.sub);
  }
}

@Controller('liff/invites')
export class PublicTenantInviteController {
  constructor(
    private readonly invites: TenantInviteService,
    private readonly idTokenVerifier: LineIdTokenVerifier,
  ) {}

  /**
   * `POST /liff/invites/peek` — LIFF preview before commit. No idToken
   * required for peek (read-only, narrow lookup) but rate-limited at
   * the gateway / WAF layer. Returns redacted tenant info or 404/410.
   */
  @Post('peek')
  @Public()
  @HttpCode(200)
  peek(
    @ZodBody(peekTenantInviteInputSchema) body: PeekTenantInviteInput,
  ): Promise<TenantInvitePreview> {
    return this.invites.peek(body.code);
  }

  /**
   * `POST /liff/invites/redeem` — verifies the LINE idToken, extracts
   * `lineUserId`, and atomically binds the tenant.
   *
   * Errors surfaced to the client (mapped from service exceptions):
   *   401 INVALID_LINE_ID_TOKEN   — idToken bad/expired/aud-mismatch
   *   404 TenantInviteNotFound    — code not recognised
   *   409 BIND_CONFLICT           — lineUserId already bound to another tenant
   *   409 TenantInviteRaceLost    — concurrent redeem won
   *   410 TenantInviteNotPending  — already redeemed/revoked
   *   410 TenantInviteExpired     — TTL elapsed
   */
  @Post('redeem')
  @Public()
  @HttpCode(200)
  async redeem(
    @ZodBody(redeemTenantInviteInputSchema) body: RedeemTenantInviteInput,
  ): Promise<RedeemTenantInviteResponse> {
    const verified = await this.idTokenVerifier.verify(body.lineIdToken);
    return this.invites.redeem(body.code, verified.lineUserId);
  }
}
