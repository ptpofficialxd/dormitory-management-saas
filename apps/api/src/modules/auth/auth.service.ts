import { hashPassword, prisma, verifyPassword, withTenant } from '@dorm/db';
import type { Role } from '@dorm/shared';
import { validateSlug } from '@dorm/shared/slug';
import type {
  AdminJwtClaims,
  AuthTokens,
  CheckSlugResponse,
  LoginAdminInput,
  LoginLiffInput,
  LoginLiffResponse,
  RefreshTokenInput,
  SignupInput,
  SignupResponse,
  TenantAuthToken,
} from '@dorm/shared/zod';
import {
  BadRequestException,
  ConflictException,
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
  // AUTH-004 self-signup (Task #113)
  // -----------------------------------------------------------------------

  /** Trial length granted to every fresh signup. SAAS-001..003 will own this. */
  private static readonly TRIAL_DAYS = 14;

  /**
   * Check whether a slug is available for a NEW company. Decision tree:
   *   1. Run shape + reserved-word validation locally (no DB hit).
   *   2. If shape OK → query company.slug uniqueness via the RLS-bypass path
   *      (same posture as `lookupCompanyBySlug` — narrow `select { id }`).
   *
   * The endpoint is PUBLIC + idempotent — used by the signup form to give
   * instant feedback as the admin types. Rate-limit (Task #115) sits in front.
   */
  async checkSlugAvailability(slug: string): Promise<CheckSlugResponse> {
    const shape = validateSlug(slug);
    if (!shape.ok) {
      return { available: false, reason: shape.error };
    }
    const existing = await withTenant({ companyId: '', bypassRls: true }, () =>
      prisma.company.findUnique({
        where: { slug: shape.value },
        select: { id: true },
      }),
    );
    return existing ? { available: false, reason: 'taken' } : { available: true };
  }

  /**
   * Self-signup wizard entry point. Creates Company + User + RoleAssignment
   * (`company_owner`) + an audit row in a single bypass-RLS tx, then mints the
   * usual access+refresh pair so the client can drop straight into `/c/:slug`.
   *
   * Why bypass-RLS:
   *   - the company row doesn't exist yet, so there's no `app.company_id` to
   *     scope to. The tx is narrow (4 INSERTs against known tables) and the
   *     resulting `companyId` is stamped into the JWT claims so EVERY follow-up
   *     request immediately falls back under RLS scope.
   *
   * Validation order is "cheap first":
   *   1. Slug shape + reserved (no DB hit) → 400 BadRequest
   *   2. Slug uniqueness check (1 read) → 409 SlugTaken
   *   3. Hash password (~60ms CPU)
   *   4. Tx: insert Company → User → RoleAssignment → AuditLog
   *      The `(companyId, email)` unique constraint on User is impossible to
   *      hit here (brand new company), but we still catch P2002 defensively.
   *   5. Issue tokens.
   *
   * Audit posture: write the audit row INSIDE the tx so signup + audit either
   * both land or both roll back. AuditLogInterceptor skips public endpoints,
   * so we own the write here.
   *
   * Email lowercased before persisting. `acceptTerms` is enforced by Zod
   * (literal-true), so the service can assume `input.acceptTerms === true`.
   */
  async signup(input: SignupInput): Promise<SignupResponse> {
    // Step 1 — slug shape + reserved-word check (no DB hit).
    const slugCheck = validateSlug(input.slug);
    if (!slugCheck.ok) {
      throw new BadRequestException({
        error: 'InvalidSlug',
        reason: slugCheck.error,
        message: this.slugReasonToMessage(slugCheck.error),
      });
    }
    const slug = slugCheck.value;
    const email = input.ownerEmail.toLowerCase();

    // Step 2 — uniqueness check before doing the expensive Argon2 hash. Saves
    // ~60ms on the dupe-slug path (common during signup retries).
    const existing = await withTenant({ companyId: '', bypassRls: true }, () =>
      prisma.company.findUnique({ where: { slug }, select: { id: true } }),
    );
    if (existing) {
      throw new ConflictException({ error: 'SlugTaken', message: `Slug "${slug}" is taken` });
    }

    // Step 3 — hash password (CPU heavy, do it OUTSIDE the tx so we don't hold
    // a connection while Argon2 runs).
    const passwordHash = await hashPassword(input.ownerPassword);

    // Step 4 — single tx that creates the company graph. P2002 here would
    // indicate a race between the dupe-check above and the INSERT; we rethrow
    // as 409 so the client sees a consistent error.
    const trialEndsAt = new Date(Date.now() + AuthService.TRIAL_DAYS * 24 * 60 * 60 * 1000);
    let created: { companyId: string; userId: string };
    try {
      created = await withTenant({ companyId: '', bypassRls: true }, async () => {
        const company = await prisma.company.create({
          data: {
            slug,
            name: input.companyName.trim(),
            // status defaults to 'active' via Prisma. trialEndsAt + plan are
            // SAAS-001..003 placeholders — backend doesn't gate on them yet.
            trialEndsAt,
            plan: 'free',
          },
          select: { id: true },
        });

        const user = await prisma.user.create({
          data: {
            companyId: company.id,
            email,
            passwordHash,
            displayName: input.ownerDisplayName.trim(),
            // emailVerifiedAt left null — Phase 1 will add the magic-link flow
            // that backfills this column via /auth/verify-email.
          },
          select: { id: true },
        });

        await prisma.roleAssignment.create({
          data: {
            companyId: company.id,
            userId: user.id,
            role: 'company_owner',
          },
        });

        // In-tx audit row. Public endpoint → AuditLogInterceptor skips it, so
        // we write directly. Falls back atomically with the rest of the tx.
        //
        // `actorUserId` is intentionally null — at the moment of signup the
        // "actor" is anonymous public, not a logged-in user. Stamping it with
        // `user.id` would also tie our hands later: AuditLog.actor relation
        // is `onDelete: SetNull` (UPDATE), but the audit_log table has an
        // append-only trigger blocking UPDATE — so a non-null actorUserId
        // would prevent ever deleting the user. We keep userId in metadata
        // instead (still queryable, doesn't trigger an FK update on delete).
        await prisma.auditLog.create({
          data: {
            companyId: company.id,
            actorUserId: null,
            action: 'signup.success',
            resource: 'company',
            resourceId: company.id,
            metadata: {
              slug,
              plan: 'free',
              trialDays: AuthService.TRIAL_DAYS,
              userId: user.id,
              ownerEmail: email,
            },
          },
        });

        return { companyId: company.id, userId: user.id };
      });
    } catch (err) {
      // Race-condition fallback: the dupe-slug check passed but a parallel
      // signup beat us to the INSERT. Surface as 409 same as Step 2.
      if (this.isUniqueConstraintError(err, 'company_slug_key')) {
        throw new ConflictException({
          error: 'SlugTaken',
          message: `Slug "${slug}" is taken`,
        });
      }
      throw err;
    }

    // Step 5 — issue tokens. Fresh owner gets exactly one role: company_owner.
    const tokens = await this.issueTokens({
      sub: created.userId,
      companyId: created.companyId,
      companySlug: slug,
      email,
      roles: ['company_owner'],
    });

    return {
      ...tokens,
      companyId: created.companyId,
      companySlug: slug,
    };
  }

  /** UX-friendly Thai message for each `validateSlug` failure mode. */
  private slugReasonToMessage(
    reason: 'too_short' | 'too_long' | 'invalid_chars' | 'reserved',
  ): string {
    switch (reason) {
      case 'too_short':
        return 'Slug ต้องยาวอย่างน้อย 2 ตัวอักษร';
      case 'too_long':
        return 'Slug ยาวเกิน 64 ตัวอักษร';
      case 'invalid_chars':
        return 'Slug ใช้ได้เฉพาะตัวพิมพ์เล็ก / ตัวเลข / ขีดกลาง — ห้ามขึ้นต้นหรือลงท้ายด้วยขีดกลาง';
      case 'reserved':
        return 'Slug นี้สงวนไว้สำหรับระบบ — กรุณาเลือกชื่ออื่น';
    }
  }

  /**
   * Detect Prisma's `P2002` unique-constraint error scoped to a specific
   * index. Mirrors `isUniqueConstraintError` in property.service.ts but kept
   * local to keep the auth module self-contained.
   */
  private isUniqueConstraintError(err: unknown, indexFragment: string): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: string; meta?: { target?: unknown } };
    if (e.code !== 'P2002') return false;
    const target = e.meta?.target;
    if (Array.isArray(target)) {
      return target.some((t) => String(t).includes(indexFragment));
    }
    return typeof target === 'string' && target.includes(indexFragment);
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
