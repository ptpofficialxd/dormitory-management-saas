/**
 * `GET /c/:slug/me` response schema (Task #118).
 *
 * The combined "current admin context" payload — company summary + user
 * profile + roles + computed entitlements. Web-admin uses this on every
 * authenticated page to drive nav state, trial banner, plan badge, and
 * RBAC-gated UI affordances.
 *
 * Why entitlements lives here (not on every endpoint):
 *   - Single round-trip on app load gives the SPA enough context to render
 *     the chrome correctly without sprinkling `/entitlements` calls.
 *   - Plan/trial state changes are rare (manual upgrades) — clients can
 *     refetch /me on focus / interval if needed.
 *
 * The shape is deliberately flat and read-only. It's NOT the place to add
 * tenant settings, feature flags, etc. — those get their own endpoints.
 */

import { z } from 'zod';
import { entitlementsSchema } from '../billing/entitlements.js';
import { companyStatusSchema } from './company.js';
import { companyIdSchema, emailSchema, roleSchema, slugSchema, uuidSchema } from './primitives.js';

export const meResponseSchema = z.object({
  company: z.object({
    id: companyIdSchema,
    slug: slugSchema,
    name: z.string().min(1).max(128),
    status: companyStatusSchema,
  }),
  user: z.object({
    id: uuidSchema,
    email: emailSchema,
    displayName: z.string().min(1).max(128),
    status: z.enum(['active', 'disabled']),
    /** ISO 8601 UTC. Null for users who have never logged in (shouldn't reach /me but defensive). */
    lastLoginAt: z.string().datetime({ offset: false }).nullable(),
  }),
  /** Roles from the JWT — pre-aggregated so the client doesn't decode the token. */
  roles: z.array(roleSchema).min(1),
  /** Plan + trial state + computed limits — see `@dorm/shared/billing`. */
  entitlements: entitlementsSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;
