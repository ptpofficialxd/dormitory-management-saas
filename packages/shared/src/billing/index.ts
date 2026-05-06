/**
 * Subscription tier + entitlements barrel (Task #117).
 *
 * Import via:
 *   import { computeEntitlements, getPlanLimits } from '@dorm/shared/billing';
 * or root re-export:
 *   import { billing } from '@dorm/shared'; // billing.computeEntitlements(...)
 */

export {
  PLAN_LIMITS,
  getPlanLimits,
  isWithinLimit,
  planRank,
  planDisplayName,
  type PlanLimits,
} from './plan-limits.js';

export {
  computeEntitlements,
  entitlementsSchema,
  type Entitlements,
  type EntitlementsWire,
} from './entitlements.js';
