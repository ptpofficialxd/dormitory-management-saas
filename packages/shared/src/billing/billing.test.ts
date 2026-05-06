import { describe, expect, it } from 'vitest';
import { PLANS, type Plan } from '../constants.js';
import {
  PLAN_LIMITS,
  computeEntitlements,
  entitlementsSchema,
  getPlanLimits,
  isWithinLimit,
  planDisplayName,
  planRank,
} from './index.js';

// =========================================================================
// PLAN_LIMITS — drift canary (every plan must have every key)
// =========================================================================

describe('PLAN_LIMITS', () => {
  it('covers every Plan in PLANS exactly', () => {
    expect(Object.keys(PLAN_LIMITS).sort()).toEqual([...PLANS].sort());
  });

  it('every entry has the full PlanLimits shape', () => {
    for (const plan of PLANS) {
      const limits = PLAN_LIMITS[plan];
      expect(limits).toMatchObject({
        properties: expect.any(Number),
        units: expect.any(Number),
        linePush: expect.any(Boolean),
        broadcast: expect.any(Boolean),
        auditRetentionDays: expect.any(Number),
      });
    }
  });

  it('limits are monotonically non-decreasing across tiers', () => {
    const tiered: Plan[] = ['free', 'starter', 'pro', 'business'];
    for (let i = 1; i < tiered.length; i++) {
      const prev = tiered[i - 1];
      const curr = tiered[i];
      if (!prev || !curr) continue; // satisfies noUncheckedIndexedAccess
      const a = PLAN_LIMITS[prev];
      const b = PLAN_LIMITS[curr];
      expect(b.properties).toBeGreaterThanOrEqual(a.properties);
      expect(b.units).toBeGreaterThanOrEqual(a.units);
      expect(b.auditRetentionDays).toBeGreaterThanOrEqual(a.auditRetentionDays);
    }
  });

  it('business tier is unlimited for countable resources', () => {
    expect(PLAN_LIMITS.business.properties).toBe(Number.POSITIVE_INFINITY);
    expect(PLAN_LIMITS.business.units).toBe(Number.POSITIVE_INFINITY);
  });

  it('free tier disables LINE features', () => {
    expect(PLAN_LIMITS.free.linePush).toBe(false);
    expect(PLAN_LIMITS.free.broadcast).toBe(false);
  });
});

// =========================================================================
// getPlanLimits + isWithinLimit + planRank + planDisplayName
// =========================================================================

describe('getPlanLimits', () => {
  it('returns the limits for a known plan', () => {
    expect(getPlanLimits('starter').properties).toBe(3);
  });

  it('throws on unknown plan', () => {
    expect(() => getPlanLimits('enterprise' as Plan)).toThrow(/Unknown plan/);
  });
});

describe('isWithinLimit', () => {
  it('allows when below limit', () => {
    expect(isWithinLimit('free', 'units', 5)).toBe(true);
  });

  it('allows the exact limit (boundary case — N+1 = max)', () => {
    expect(isWithinLimit('free', 'units', 9)).toBe(true);
  });

  it('rejects when next write would push count over', () => {
    expect(isWithinLimit('free', 'units', 10)).toBe(false);
  });

  it('always allows on business tier (Infinity)', () => {
    expect(isWithinLimit('business', 'units', 1_000_000)).toBe(true);
  });
});

describe('planRank', () => {
  it('orders tiers low → high', () => {
    expect(planRank('free')).toBeLessThan(planRank('starter'));
    expect(planRank('starter')).toBeLessThan(planRank('pro'));
    expect(planRank('pro')).toBeLessThan(planRank('business'));
  });
});

describe('planDisplayName', () => {
  it('returns a non-empty Thai/English label for every plan', () => {
    for (const plan of PLANS) {
      expect(planDisplayName(plan).length).toBeGreaterThan(0);
    }
  });
});

// =========================================================================
// computeEntitlements
// =========================================================================

describe('computeEntitlements', () => {
  const NOW = new Date('2026-05-06T10:00:00Z');

  it('null trialEndsAt → no trial state, plan limits attached', () => {
    const e = computeEntitlements('starter', null, NOW);
    expect(e).toMatchObject({
      plan: 'starter',
      inTrial: false,
      trialExpired: false,
      trialDaysRemaining: null,
      trialEndsAt: null,
    });
    expect(e.limits).toEqual(PLAN_LIMITS.starter);
  });

  it('future trialEndsAt → inTrial=true, days remaining counted', () => {
    const future = new Date('2026-05-13T10:00:00Z'); // 7 days
    const e = computeEntitlements('free', future, NOW);
    expect(e.inTrial).toBe(true);
    expect(e.trialExpired).toBe(false);
    expect(e.trialDaysRemaining).toBe(7);
    expect(e.trialEndsAt).toBe('2026-05-13T10:00:00.000Z');
  });

  it('partial day remaining rounds UP (5h → 1 day)', () => {
    const future = new Date('2026-05-06T15:00:00Z'); // 5h later
    const e = computeEntitlements('free', future, NOW);
    expect(e.trialDaysRemaining).toBe(1);
  });

  it('exactly at expiry → trialExpired=true, days null', () => {
    const e = computeEntitlements('free', NOW, NOW);
    expect(e.inTrial).toBe(false);
    expect(e.trialExpired).toBe(true);
    expect(e.trialDaysRemaining).toBeNull();
  });

  it('past trialEndsAt → trialExpired=true', () => {
    const past = new Date('2026-04-01T00:00:00Z');
    const e = computeEntitlements('free', past, NOW);
    expect(e.trialExpired).toBe(true);
    expect(e.inTrial).toBe(false);
    expect(e.trialDaysRemaining).toBeNull();
  });

  it('default `now` uses wall clock — smoke test only (no flakiness)', () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const e = computeEntitlements('free', future);
    expect(e.inTrial).toBe(true);
  });
});

// =========================================================================
// entitlementsSchema (wire format)
// =========================================================================

describe('entitlementsSchema', () => {
  const validWire = {
    plan: 'starter' as const,
    limits: {
      properties: 3,
      units: 50,
      linePush: true,
      broadcast: false,
      auditRetentionDays: 30,
    },
    inTrial: true,
    trialExpired: false,
    trialDaysRemaining: 7,
    trialEndsAt: '2026-05-13T10:00:00.000Z',
  };

  it('accepts a valid envelope', () => {
    expect(entitlementsSchema.safeParse(validWire).success).toBe(true);
  });

  it('round-trips computeEntitlements output through the wire schema', () => {
    const computed = computeEntitlements(
      'pro',
      new Date('2026-05-13T10:00:00Z'),
      new Date('2026-05-06T10:00:00Z'),
    );
    const result = entitlementsSchema.safeParse(computed);
    expect(result.success).toBe(true);
  });

  it('accepts Infinity limit for business tier', () => {
    const computed = computeEntitlements('business', null);
    const result = entitlementsSchema.safeParse(computed);
    expect(result.success).toBe(true);
  });

  it('rejects unknown plan', () => {
    expect(entitlementsSchema.safeParse({ ...validWire, plan: 'enterprise' }).success).toBe(false);
  });

  it('rejects when trialDaysRemaining is negative', () => {
    expect(entitlementsSchema.safeParse({ ...validWire, trialDaysRemaining: -1 }).success).toBe(
      false,
    );
  });
});
