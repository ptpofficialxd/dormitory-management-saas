import { prisma } from '@dorm/db';
import { getTenantContext } from '@dorm/db';
import type { Plan } from '@dorm/shared';
import { type Entitlements, computeEntitlements } from '@dorm/shared/billing';
import type {
  AdminJwtClaims,
  Company,
  MeResponse,
  UpdatePromptPaySettingsInput,
} from '@dorm/shared/zod';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';

/**
 * Read + minimal-mutation company operations.
 *
 * MVP scope:
 *   - Read: GET /me (current admin's profile + their company)
 *   - Read: getById (powers the Settings page)
 *   - Mutation: setPromptPay (owner-only, dedicated endpoint per
 *     `updatePromptPaySettingsInputSchema` in shared/zod)
 *
 * Other Company-row CRUD (create / rename / delete / status flip) is a
 * platform-level concern (only `super_admin` — out of MVP scope) so we
 * don't expose generic update endpoints here.
 *
 * Queries run through the shared `prisma` Proxy → `TenantContextInterceptor`
 * must have already set `app.company_id` on the active tx. Without it,
 * RLS default-denies and writes silently no-op → we'd never spot a
 * missing context bug, which is why we throw on `!ctx?.companyId`.
 */
@Injectable()
export class CompanyService {
  private readonly logger = new Logger(CompanyService.name);

  /** Threshold for surfacing the "trial ending soon" banner + audit warn. */
  private static readonly TRIAL_WARN_DAYS_THRESHOLD = 7;
  /** Idempotency window for `trial.warning` audit emit — gate to once / 24h. */
  private static readonly TRIAL_WARN_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

  /**
   * `GET /me` payload — current user's profile + their company + computed
   * entitlements (Task #118). Drives the SPA's nav state, trial banner, and
   * plan badge in one round-trip on app load.
   *
   * Entitlements are derived from `Company.plan` + `Company.trialEndsAt`
   * via the pure `computeEntitlements` helper in `@dorm/shared/billing`.
   * The DB columns came in Task #111 — `plan` defaults to `'free'`, and
   * `trialEndsAt` is set at signup time (now + 14 days) for new companies.
   * Legacy seeded companies with `trialEndsAt=null` get a no-trial entitlements
   * snapshot (the UI renders no countdown banner in that case).
   */
  async getMe(claims: AdminJwtClaims): Promise<MeResponse> {
    const [company, user] = await Promise.all([
      prisma.company.findUnique({
        where: { id: claims.companyId },
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
          plan: true,
          trialEndsAt: true,
        },
      }),
      prisma.user.findUnique({
        where: { id: claims.sub },
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          lastLoginAt: true,
        },
      }),
    ]);

    if (!company || !user) {
      // Either the tenant context is wrong (RLS hid the rows) or the user
      // was deleted between token-issue and now. Return 404 to avoid leaking
      // details; client should force a re-login.
      throw new NotFoundException('Profile not found');
    }

    // `plan` is nullable in Prisma (defaults via @default(free) at DB level
    // for new rows; legacy rows pre-Task-#111 may be null until backfill ran).
    // Treat null as 'free' defensively so the UI never sees an undefined tier.
    const plan: Plan = (company.plan ?? 'free') as Plan;
    const entitlements = computeEntitlements(plan, company.trialEndsAt);

    // Fire-and-forget — don't block /me on the audit write. A failure here
    // means the banner still shows (entitlements is computed locally) but
    // the audit trail misses one warning row, which is acceptable.
    void this.maybeEmitTrialWarning(claims.companyId, entitlements);

    return {
      company: {
        id: company.id,
        slug: company.slug,
        name: company.name,
        status: company.status,
      },
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      },
      roles: claims.roles,
      entitlements,
    };
  }

  /**
   * Emit a `trial.warning` audit row when the company's trial is within
   * `TRIAL_WARN_DAYS_THRESHOLD` days of ending — but no more than once per
   * 24 hours per company (so /me being polled every page load doesn't spam
   * the audit log).
   *
   * Idempotency strategy: read-then-write (NOT transactional). A lost race
   * could insert two rows; we accept that — audit log is append-only and
   * "warning emitted twice" is harmless. The proper fix is a unique index
   * on `(companyId, action, date_trunc('day', createdAt))` but Phase 1 will
   * add that when SAAS-004 lands.
   *
   * Skipped silently for:
   *   - Companies not in trial (legacy rows w/ null trialEndsAt, or paid plans)
   *   - Trials with >7 days remaining (banner not shown, no need to log)
   *   - Already-expired trials (too late to warn — Phase 1 will emit
   *     `trial.expired` separately)
   */
  private async maybeEmitTrialWarning(
    companyId: string,
    entitlements: Entitlements,
  ): Promise<void> {
    if (!entitlements.inTrial) return;
    if (entitlements.trialDaysRemaining === null) return;
    if (entitlements.trialDaysRemaining > CompanyService.TRIAL_WARN_DAYS_THRESHOLD) return;

    try {
      const since = new Date(Date.now() - CompanyService.TRIAL_WARN_DEDUP_WINDOW_MS);
      const recent = await prisma.auditLog.findFirst({
        where: {
          companyId,
          action: 'trial.warning',
          resource: 'company',
          resourceId: companyId,
          createdAt: { gte: since },
        },
        select: { id: true },
      });
      if (recent) return;

      await prisma.auditLog.create({
        data: {
          companyId,
          // System-emitted (not user-initiated) — null actor matches the
          // signup audit pattern. UserId tracking via metadata if needed later.
          actorUserId: null,
          action: 'trial.warning',
          resource: 'company',
          resourceId: companyId,
          metadata: {
            plan: entitlements.plan,
            trialDaysRemaining: entitlements.trialDaysRemaining,
            trialEndsAt: entitlements.trialEndsAt,
          },
        },
      });
    } catch (err) {
      this.logger.warn(
        `[trial.warning] emit failed for company=${companyId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * `GET /c/:slug/settings` payload — full company row for the Settings page
   * (includes `promptPayId` + `promptPayName` which `getMe` deliberately
   * omits to keep that hot-path response small).
   *
   * RLS scopes the query to the active company; the controller-level
   * `PathCompanyGuard` already verified the slug-vs-JWT match, so a
   * cross-company probe never reaches here. 404 on miss is an unreachable
   * defensive — kept anyway so a future bug doesn't return `undefined`.
   */
  async getCurrent(): Promise<Company> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on getCurrent');
    }
    const row = await prisma.company.findUnique({
      where: { id: ctx.companyId },
    });
    if (!row) throw new NotFoundException('Company not found');
    return row as unknown as Company;
  }

  /**
   * `PUT /c/:slug/prompt-pay` — set the company's PromptPay payee config.
   *
   * Both fields required (per `updatePromptPaySettingsInputSchema`) so a
   * half-configured QR (id without name → "Unknown Payee" in banking apps)
   * can never persist. To CLEAR the config, hit a separate DELETE endpoint
   * (out of MVP scope) — PATCH-with-null gets ambiguous semantics fast.
   *
   * RBAC enforced at the controller via `@Perm('update', 'company')` —
   * owner-only per the shared matrix. Property managers don't touch payment
   * config (it's a money-routing decision).
   *
   * Audit log: written by the global `AuditLogInterceptor` — no special
   * handling here. Resource label derives from URL → "prompt-pay".
   */
  async setPromptPay(input: UpdatePromptPaySettingsInput): Promise<Company> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on setPromptPay');
    }
    const row = await prisma.company.update({
      where: { id: ctx.companyId },
      data: {
        promptPayId: input.promptPayId,
        promptPayName: input.promptPayName,
      },
    });
    return row as unknown as Company;
  }
}
