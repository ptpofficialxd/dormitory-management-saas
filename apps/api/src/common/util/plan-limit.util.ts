import { prisma, withTenant } from '@dorm/db';
import type { Plan } from '@dorm/shared';
import { getPlanLimits } from '@dorm/shared/billing';
import { Logger } from '@nestjs/common';

const logger = new Logger('PlanLimitGuard');

/**
 * Idempotency window for `plan.limit_exceeded` audit emit — emit at most
 * once per 24h per (companyId, resource). A noisier "every create over the
 * cap fires an audit row" floods the log with no extra signal.
 */
const PLAN_WARN_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Soft warn when a Company has just exceeded its plan-tier limit on a
 * countable resource (Task #122).
 *
 * v1 = warn-only (per the SAAS-001 trade-off chosen at planning):
 *   - Caller has already created the resource. We just observe the count.
 *   - If `count > limit` we emit `plan.limit_exceeded` to the audit log,
 *     dedup'd to once per 24h per (company × resource).
 *   - We do NOT throw — admin can keep creating during the beta. Phase 1
 *     (SAAS-004) will swap the audit emit for a hard 402 on the same code path.
 *
 * Fire-and-forget at the call site:
 *   void softWarnPlanLimit({ companyId, resource: 'units', count });
 *
 * Errors are swallowed + logged — a failed audit emit must NOT cascade
 * into a failed create response.
 */
export async function softWarnPlanLimit(args: {
  companyId: string;
  resource: 'properties' | 'units';
  /**
   * Current count AFTER the create that triggered this check. We compare
   * `count > limit` directly — the `+1` arithmetic in `isWithinLimit()`
   * is for the pre-create case, which we don't use here.
   */
  count: number;
}): Promise<void> {
  try {
    // Load the active plan via the same bypass-RLS narrow query the
    // login flow uses. Limited to `select { plan }` so a hijacked context
    // can't fan out to other columns.
    const company = await withTenant({ companyId: '', bypassRls: true }, () =>
      prisma.company.findUnique({
        where: { id: args.companyId },
        select: { plan: true },
      }),
    );
    const plan: Plan = (company?.plan ?? 'free') as Plan;
    const limit = getPlanLimits(plan)[args.resource];

    // Business / Infinity tier — never warn.
    if (!Number.isFinite(limit) || args.count <= limit) return;

    // Dedup — only one warning row per (company × resource) per 24 hours.
    const since = new Date(Date.now() - PLAN_WARN_DEDUP_WINDOW_MS);
    const recent = await prisma.auditLog.findFirst({
      where: {
        companyId: args.companyId,
        action: 'plan.limit_exceeded',
        resource: args.resource,
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    if (recent) return;

    await prisma.auditLog.create({
      data: {
        companyId: args.companyId,
        // System-emitted (post-create observation, not a user action) —
        // matches the signup + trial.warning pattern.
        actorUserId: null,
        action: 'plan.limit_exceeded',
        resource: args.resource,
        resourceId: null,
        metadata: {
          plan,
          limit,
          count: args.count,
          // Phase 1 will surface this in the upgrade banner / settings.
          overBy: args.count - limit,
        },
      },
    });
  } catch (err) {
    logger.warn(
      `[plan.limit_exceeded] emit failed for company=${args.companyId} resource=${args.resource}: ${(err as Error).message}`,
    );
  }
}
