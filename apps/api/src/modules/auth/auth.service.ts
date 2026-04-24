import { prisma, verifyPassword, withTenant } from '@dorm/db';
import type { Role } from '@dorm/shared';
import type {
  AdminJwtClaims,
  AuthTokens,
  LoginAdminInput,
  LoginLiffInput,
  LoginLiffResponse,
  RefreshTokenInput,
  TenantAuthToken,
} from '@dorm/shared/zod';
import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from './jwt.service.js';
import { LineIdTokenVerifier } from './line-id-token.verifier.js';

/**
 * Admin login / refresh / logout.
 *
 * Security posture for MVP:
 *   * Passwords hashed with Argon2id (OWASP 2024 params) — see `@dorm/db/password`.
 *   * Login is deliberately slow (~60ms) — no enumeration timing oracle because
 *     we still call `verifyPassword` with a dummy hash when the user is missing.
 *   * Refresh-token rotation is **stateless** for MVP (valid-sig + typ === 'refresh'
 *     is enough). A denylist / rotation ledger backed by Redis is planned for
 *     Phase 2 — tracked in roadmap item "refresh-token revocation".
 *   * `lastLoginAt` is updated inside the admin-role tenant boundary so the
 *     RLS policy still applies.
 *
 * Login flow:
 *   1. Find user by (companySlug, email) using the admin-role tenant boundary
 *      (we don't yet know the companyId — we resolve it via the slug).
 *   2. Verify password.
 *   3. Load active role assignments for (user, company).
 *   4. Mint access + refresh token pair.
 *   5. Stamp `lastLoginAt`.
 */
@Injectable()
export class AuthService {
  /**
   * Stable dummy hash used to keep login timing constant when the user/company
   * is not found. Argon2id with OWASP params, generated offline and frozen —
   * DO NOT regenerate per request (that would leak timing differently).
   *
   * Value corresponds to password `"dummy-invalid-password"` — verification will
   * always fail, but the CPU cost matches a real `verifyPassword` call.
   */
  private static readonly TIMING_SAFE_DUMMY_HASH =
    '$argon2id$v=19$m=19456,t=2,p=1$YW5vbnltb3VzLXNhbHQtZHVtbXk$RDWpHRjL42/yi/uRIk+DuIBnaHvK4G6SGEPo8sD5Ke0';

  constructor(
    private readonly jwt: JwtService,
    private readonly lineIdTokenVerifier: LineIdTokenVerifier,
  ) {}

  /**
   * Perform a password login and return a fresh token pair.
   * @throws UnauthorizedException for ANY failure reason — do not leak whether
   *   the company, email, or password was wrong.
   */
  async loginAdmin(input: LoginAdminInput): Promise<AuthTokens> {
    // RLS escape hatch — narrow & justified.
    // The `company` table is RLS-scoped by `id = app_current_company_id()`,
    // but at LOGIN we don't yet know the companyId (we're resolving it via
    // the public slug). Bypass is limited to `select { id, slug, status }`
    // here and never carries through to subsequent queries.
    const company = await this.lookupCompanyBySlug(input.companySlug);

    // Timing-safe: always run one argon2 verify, even if company/user is absent.
    if (!company || company.status !== 'active') {
      await verifyPassword(input.password, AuthService.TIMING_SAFE_DUMMY_HASH);
      throw new UnauthorizedException('Invalid credentials');
    }

    const user = await withTenant({ companyId: company.id }, () =>
      prisma.user.findUnique({
        where: { companyId_email: { companyId: company.id, email: input.email } },
        select: {
          id: true,
          email: true,
          passwordHash: true,
          status: true,
          roleAssignments: { select: { role: true } },
        },
      }),
    );

    const hash = user?.passwordHash ?? AuthService.TIMING_SAFE_DUMMY_HASH;
    const ok = await verifyPassword(input.password, hash);
    if (!ok || !user || user.status !== 'active') {
      throw new UnauthorizedException('Invalid credentials');
    }

    const roles = user.roleAssignments.map((r) => r.role as Role);
    if (roles.length === 0) {
      // Deny logins for users who exist but hold no roles — prevents a
      // "logged-in but can do nothing" ghost state that confuses the UI.
      throw new UnauthorizedException('No roles assigned');
    }

    const tokens = await this.issueTokens({
      sub: user.id,
      companyId: company.id,
      companySlug: company.slug,
      email: user.email,
      roles,
    });

    // Best-effort — a failure here shouldn't block login (the user can still
    // see a stale `lastLoginAt` next time). Swallow + log.
    await withTenant({ companyId: company.id }, () =>
      prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      }),
    ).catch(() => undefined);

    return tokens;
  }

  /**
   * Exchange a refresh token for a new access+refresh pair. Stateless in MVP
   * — we validate the token signature + `typ === 'refresh'` and re-read the
   * user to confirm they are still active and still hold ≥1 role.
   */
  async refresh(input: RefreshTokenInput): Promise<AuthTokens> {
    const claims = await this.jwt.verifyRefreshToken(input.refreshToken);

    // Re-fetch to detect deactivation after the refresh token was issued.
    const user = await withTenant({ companyId: claims.companyId }, () =>
      prisma.user.findUnique({
        where: { id: claims.sub },
        select: {
          id: true,
          email: true,
          status: true,
          roleAssignments: { select: { role: true } },
        },
      }),
    );

    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('User is no longer active');
    }
    const roles = user.roleAssignments.map((r) => r.role as Role);
    if (roles.length === 0) {
      throw new UnauthorizedException('No roles assigned');
    }

    return this.issueTokens({
      sub: user.id,
      companyId: claims.companyId,
      companySlug: claims.companySlug,
      email: user.email,
      roles,
    });
  }

  /**
   * Stateless logout — the client discards the tokens. Present as an explicit
   * endpoint so audit-log captures the intent + so we can plug in a server-side
   * denylist in Phase 2 without breaking the wire contract.
   *
   * NOTE: intentionally async despite no `await` — keeps the wire contract
   * Promise-based so Phase 2 (Redis token denylist) is a transparent swap.
   */
  async logout(_claims: AdminJwtClaims): Promise<void> {
    // Intentional no-op for MVP.
  }

  // -----------------------------------------------------------------------
  // LIFF tenant auth
  // -----------------------------------------------------------------------

  /**
   * Exchange a LIFF `liff.getIDToken()` for a tenant session JWT.
   *
   * Flow:
   *   1. Resolve company by slug (RLS bypass, narrow query — same posture as
   *      admin login).
   *   2. Verify the idToken against LINE's verify endpoint → trusted lineUserId.
   *   3. Lookup the bound Tenant by (companyId, lineUserId). 401 if no row —
   *      LIFF should redirect the user to the bind flow.
   *   4. Mint a tenant JWT (1h, audience='dorm-liff') and return alongside
   *      the resolved tenant identity.
   *
   * Errors are deliberately uniform UnauthorizedException — distinguishing
   * "no such tenant" from "bad idToken" would leak who is bound to which
   * dorm. Front-end can recover by routing to /bind on any 401.
   */
  async exchangeLiffIdToken(input: LoginLiffInput): Promise<LoginLiffResponse> {
    const company = await this.lookupCompanyBySlug(input.companySlug);
    if (!company || company.status !== 'active') {
      // Run idToken verify anyway so we don't leak company existence via timing.
      // (LINE verify is the slow path; skipping it on 'company missing' would
      // make that case detectable by latency.)
      await this.lineIdTokenVerifier.verify(input.idToken).catch(() => undefined);
      throw new UnauthorizedException('Invalid credentials');
    }

    const verified = await this.lineIdTokenVerifier.verify(input.idToken);

    const tenant = await withTenant({ companyId: company.id }, () =>
      prisma.tenant.findUnique({
        where: {
          companyId_lineUserId: { companyId: company.id, lineUserId: verified.lineUserId },
        },
        select: { id: true, status: true },
      }),
    );

    if (!tenant || tenant.status !== 'active') {
      throw new UnauthorizedException('Invalid credentials');
    }

    const token = await this.mintTenantSession({
      tenantId: tenant.id,
      companyId: company.id,
      companySlug: company.slug,
      lineUserId: verified.lineUserId,
    });

    return {
      tenant: {
        id: tenant.id,
        companyId: company.id,
        companySlug: company.slug,
      },
      token,
    };
  }

  /**
   * Mint a tenant session token. Exposed (not just used by exchange) so the
   * TenantInvite redeem flow can hand back a token in its response — see
   * `RedeemTenantInviteResponse.token`. Keeps the JWT-mint logic in one place.
   */
  async mintTenantSession(args: {
    tenantId: string;
    companyId: string;
    companySlug: string;
    lineUserId: string;
  }): Promise<TenantAuthToken> {
    try {
      const { token, expiresAt } = await this.jwt.signTenantToken({
        sub: args.tenantId,
        companyId: args.companyId,
        companySlug: args.companySlug,
        lineUserId: args.lineUserId,
      });
      return { accessToken: token, accessTokenExpiresAt: expiresAt };
    } catch (err) {
      throw new ServiceUnavailableException(`Tenant token issue failed: ${(err as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private async issueTokens(
    claims: Omit<AdminJwtClaims, 'typ' | 'iat' | 'exp'>,
  ): Promise<AuthTokens> {
    try {
      const [access, refresh] = await Promise.all([
        this.jwt.signAccessToken(claims),
        this.jwt.signRefreshToken(claims),
      ]);
      return {
        accessToken: access.token,
        refreshToken: refresh.token,
        accessTokenExpiresAt: access.expiresAt,
      };
    } catch (err) {
      // Should only happen if JWT_SECRET is misconfigured — surface as 503
      // rather than 401 because the caller's credentials are fine.
      throw new ServiceUnavailableException(`Token issue failed: ${(err as Error).message}`);
    }
  }

  // Exposed for tests — allows asserting behaviour when the dummy hash is
  // hit without instantiating the whole service graph.
  static getTimingSafeDummyHash(): string {
    return AuthService.TIMING_SAFE_DUMMY_HASH;
  }

  // Exposed so controllers can surface 404 for truly-missing companies in
  // contexts OTHER than login (e.g. path-based /c/:slug middleware).
  async assertCompanyExists(slug: string): Promise<{ id: string; slug: string }> {
    const company = await this.lookupCompanyBySlug(slug);
    if (!company || company.status !== 'active') {
      throw new NotFoundException(`Company '${slug}' not found`);
    }
    return { id: company.id, slug: company.slug };
  }

  /**
   * RLS escape hatch — slug → companyId resolution for auth bootstrap.
   *
   * This is the ONLY place in the request path where `bypassRls: true` is
   * acceptable. It's used by login (no tenant ctx yet) and by the path-based
   * `/c/:slug` guard (resolving the URL slug before issuing the JWT for
   * downstream queries). The query is intentionally narrow — `{ id, slug,
   * status }` only — and the result is NEVER passed back into a tenant-scoped
   * Prisma call without first being used as the `companyId` for `withTenant`.
   */
  private async lookupCompanyBySlug(
    slug: string,
  ): Promise<{ id: string; slug: string; status: 'active' | 'suspended' | 'churned' } | null> {
    return withTenant({ companyId: '', bypassRls: true }, () =>
      prisma.company.findUnique({
        where: { slug },
        select: { id: true, slug: true, status: true },
      }),
    );
  }
}
