/**
 * Subscription tier matrix (Task #117).
 *
 * Single source of truth for what each plan grants. Backend reads this in
 * the EntitlementContextInterceptor (Task #118) to surface limits via
 * `GET /c/:slug/me`; soft warns at create-time when over a limit.
 *
 * Phase 1 (SAAS-004) will hard-enforce these — for now we only audit-warn
 * + render a banner so beta customers don't get surprised by 402s on data
 * they already had before tiering existed.
 *
 * Tier order is low → high (free < starter < pro < business). When adding
 * a new limit:
 *   1. Extend the `PlanLimits` type below.
 *   2. Add the column to every row of `PLAN_LIMITS`.
 *   3. Update entitlementsSchema in `entitlements.ts` to include the new
 *      key on the wire.
 *   4. Surface in admin UI (PlanBadge / TrialBanner / settings page).
 *
 * Limits use `Infinity` for "unlimited" — convert at the wire boundary
 * (Zod refines `number().finite()` would reject; cast via `null` on
 * serialization). The audit-log retention is in DAYS (not units!) — it
 * gates how far back the audit-log read endpoint will return rows for
 * non-business tiers.
 */

import type { Plan } from '../constants.js';

export interface PlanLimits {
  /** Max Property rows. Hit when admin tries to create another property. */
  properties: number;
  /** Max Unit rows across all properties. */
  units: number;
  /** May the LINE notification service push individual messages? */
  linePush: boolean;
  /** May the broadcast endpoint fan out to every active tenant? */
  broadcast: boolean;
  /**
   * Audit-log read window — admins on this tier can only see rows created
   * within this many days. Older rows still exist on disk (append-only),
   * just not surfaced in the UI. Phase 1: cron prunes old rows past
   * business retention.
   */
  auditRetentionDays: number;
}

/**
 * Tier-specific limits. Numbers were sized for the Thai dorm market:
 *   - `free`: trial / hobby — single small dorm, manual everything.
 *   - `starter`: 1-3 small buildings (~50 units total) — typical entry SaaS customer.
 *   - `pro`: established operator (~10 buildings, 200 units) — broadcast unlocked.
 *   - `business`: chain operator — no caps. Phase 2 will add SLA.
 */
export const PLAN_LIMITS: Readonly<Record<Plan, PlanLimits>> = {
  free: {
    properties: 1,
    units: 10,
    linePush: false,
    broadcast: false,
    auditRetentionDays: 7,
  },
  starter: {
    properties: 3,
    units: 50,
    linePush: true,
    broadcast: false,
    auditRetentionDays: 30,
  },
  pro: {
    properties: 10,
    units: 200,
    linePush: true,
    broadcast: true,
    auditRetentionDays: 90,
  },
  business: {
    properties: Number.POSITIVE_INFINITY,
    units: Number.POSITIVE_INFINITY,
    linePush: true,
    broadcast: true,
    auditRetentionDays: 365,
  },
};

/** Lookup helper. Throws on unknown plan (caller bug — type system should prevent). */
export function getPlanLimits(plan: Plan): PlanLimits {
  const limits = PLAN_LIMITS[plan];
  if (!limits) {
    throw new Error(`Unknown plan: ${JSON.stringify(plan)}`);
  }
  return limits;
}

/**
 * Check whether `currentCount + 1` would exceed the plan limit for the given
 * countable resource. Returns `false` only if a write would push the count
 * strictly over the limit.
 *
 * Usage at create-time:
 *   const within = isWithinLimit('starter', 'units', currentUnitCount);
 *   if (!within) {
 *     // Soft warn in v1: emit audit + return success. Hard 402 in Phase 1.
 *     await auditWarn('plan.limit_exceeded', { resource: 'units', plan, current: currentUnitCount });
 *   }
 *
 * `Infinity` plans always return true.
 */
export function isWithinLimit(
  plan: Plan,
  resource: 'properties' | 'units',
  currentCount: number,
): boolean {
  const limit = getPlanLimits(plan)[resource];
  if (limit === Number.POSITIVE_INFINITY) return true;
  return currentCount + 1 <= limit;
}

/**
 * Plan ordering — used by upgrade-comparison UI ("Upgrade to Pro to unlock
 * broadcast"). Higher index = stricter tier.
 */
export function planRank(plan: Plan): number {
  switch (plan) {
    case 'free':
      return 0;
    case 'starter':
      return 1;
    case 'pro':
      return 2;
    case 'business':
      return 3;
  }
}

/** Display label for the admin UI badge / trial banner. */
export function planDisplayName(plan: Plan): string {
  switch (plan) {
    case 'free':
      return 'ฟรี';
    case 'starter':
      return 'Starter';
    case 'pro':
      return 'Pro';
    case 'business':
      return 'Business';
  }
}
