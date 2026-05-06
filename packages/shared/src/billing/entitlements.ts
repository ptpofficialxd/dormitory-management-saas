/**
 * Entitlements (Task #117) — the "what is this company allowed to do today"
 * snapshot derived from `plan` + `trialEndsAt` + current wall-clock.
 *
 * Backend computes one of these per request in EntitlementContextInterceptor
 * (Task #118) and exposes it via `GET /c/:slug/me`. Web-admin reads the
 * server-rendered shape to drive the trial banner + plan badge + nav state.
 *
 * Design notes:
 *   - Computed deterministically from inputs — pure function, no DB hits.
 *     Easy to unit test, easy to embed in a JWT claim later (Phase 1).
 *   - `trialDaysRemaining` is null when not on a trial-eligible tier OR
 *     when `trialEndsAt` is null (legacy companies, pre-Task-#111). The UI
 *     must handle null as "no countdown to show".
 *   - We DON'T mark an expired trial as "trial active" — once `now >=
 *     trialEndsAt` we flip `inTrial=false` and `trialExpired=true`. UI
 *     renders a different banner ("renew" vs "X days left").
 */

import { z } from 'zod';
import { PLANS, type Plan } from '../constants.js';
import { type PlanLimits, getPlanLimits } from './plan-limits.js';

export interface Entitlements {
  /** The active plan tier — drives `limits` + `features`. */
  plan: Plan;
  /** Resolved limits for the active plan (mirrors PlanLimits). */
  limits: PlanLimits;
  /** True while the company is within its trial window. */
  inTrial: boolean;
  /**
   * True iff the company HAS a trialEndsAt that is now in the past. Used
   * by the UI to render the "trial expired" warning vs the countdown.
   * Companies that never had a trial (trialEndsAt=null) are NOT expired.
   */
  trialExpired: boolean;
  /**
   * Whole days remaining on the trial. `null` when `trialEndsAt` is null
   * OR when the trial has already expired. Always rounded UP (5h25m left
   * → 1 day) so the banner doesn't say "0 days" until the trial truly ends.
   */
  trialDaysRemaining: number | null;
  /** ISO 8601 UTC timestamp of when the trial ends; null if not set. */
  trialEndsAt: string | null;
}

/**
 * Derive entitlements from raw company fields. Pure function — `now` is
 * injected to keep tests deterministic.
 *
 * @param plan         Company.plan (already resolved upstream; default 'free').
 * @param trialEndsAt  Company.trialEndsAt — Date or null.
 * @param now          Reference clock; defaults to wall time.
 */
export function computeEntitlements(
  plan: Plan,
  trialEndsAt: Date | null,
  now: Date = new Date(),
): Entitlements {
  const limits = getPlanLimits(plan);

  if (!trialEndsAt) {
    return {
      plan,
      limits,
      inTrial: false,
      trialExpired: false,
      trialDaysRemaining: null,
      trialEndsAt: null,
    };
  }

  const msRemaining = trialEndsAt.getTime() - now.getTime();
  const expired = msRemaining <= 0;

  return {
    plan,
    limits,
    inTrial: !expired,
    trialExpired: expired,
    trialDaysRemaining: expired
      ? null
      : Math.max(1, Math.ceil(msRemaining / (24 * 60 * 60 * 1000))),
    trialEndsAt: trialEndsAt.toISOString(),
  };
}

// -------------------------------------------------------------------------
// Wire schema — what `GET /c/:slug/me` returns + what web-admin parses.
// -------------------------------------------------------------------------

const planLimitsSchema = z.object({
  properties: z.number().int().positive().or(z.literal(Number.POSITIVE_INFINITY)),
  units: z.number().int().positive().or(z.literal(Number.POSITIVE_INFINITY)),
  linePush: z.boolean(),
  broadcast: z.boolean(),
  auditRetentionDays: z.number().int().positive(),
});

export const entitlementsSchema = z.object({
  plan: z.enum(PLANS),
  limits: planLimitsSchema,
  inTrial: z.boolean(),
  trialExpired: z.boolean(),
  trialDaysRemaining: z.number().int().positive().nullable(),
  trialEndsAt: z.string().datetime({ offset: false }).nullable(),
});
export type EntitlementsWire = z.infer<typeof entitlementsSchema>;
