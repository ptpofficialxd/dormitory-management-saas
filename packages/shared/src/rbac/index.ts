/**
 * RBAC — table-driven permission check.
 *
 * CLAUDE.md §3.13: "RBAC is table-driven (5 roles). Never hard-code role
 * checks." Consumers call `can(user, action, resource)` — the matrix is the
 * single source of truth. Adding a new feature means adding a row here, not
 * scattering `if (role === 'owner')` through the codebase.
 *
 * Design:
 *   - Resources + actions are string literals (so TS autocompletes them).
 *   - A `User`-shaped input carries `roles: Role[]` (a user can have multiple
 *     role assignments across companies — the caller resolves the active
 *     company's roles before calling `can`).
 *   - Scope: this is a PURE authz primitive. Tenant isolation (RLS) lives in
 *     `packages/db`. `can` never looks at IDs — only at role capabilities.
 */

import type { Role } from '../constants.js';

// -----------------------------------------------------------------------
// Resource / action catalog — add new entries as features land.
// -----------------------------------------------------------------------

export const RESOURCES = [
  'company',
  'property',
  'unit',
  'contract',
  'invoice',
  'payment',
  'slip',
  'meter_reading',
  'maintenance_ticket',
  'announcement',
  'tenant_user',
  'staff_user',
  'audit_log',
] as const;
export type Resource = (typeof RESOURCES)[number];

export const ACTIONS = [
  'read',
  'create',
  'update',
  'delete',
  'approve', // e.g. approving a slip, approving a move-out refund
  'broadcast', // announcements
] as const;
export type Action = (typeof ACTIONS)[number];

// -----------------------------------------------------------------------
// Matrix — row per role, listing which `${resource}:${action}` pairs are
// granted. Keep alphabetical within each role for easier diffs / reviews.
// -----------------------------------------------------------------------

type PermissionKey = `${Resource}:${Action}`;

function keys(pairs: ReadonlyArray<PermissionKey>): ReadonlySet<PermissionKey> {
  return new Set(pairs);
}

/**
 * `company_owner` — the top-level tenant admin. Full control over their own
 * company; cannot act outside RLS scope.
 */
const COMPANY_OWNER = keys([
  'announcement:broadcast',
  'announcement:create',
  'announcement:delete',
  'announcement:read',
  'announcement:update',
  'audit_log:read',
  'company:read',
  'company:update',
  'contract:create',
  'contract:delete',
  'contract:read',
  'contract:update',
  'invoice:create',
  'invoice:delete',
  'invoice:read',
  'invoice:update',
  'maintenance_ticket:approve',
  'maintenance_ticket:create',
  'maintenance_ticket:delete',
  'maintenance_ticket:read',
  'maintenance_ticket:update',
  'meter_reading:create',
  'meter_reading:delete',
  'meter_reading:read',
  'meter_reading:update',
  'payment:approve',
  'payment:create',
  'payment:read',
  'payment:update',
  'property:create',
  'property:delete',
  'property:read',
  'property:update',
  'slip:approve',
  'slip:read',
  'slip:update',
  'staff_user:create',
  'staff_user:delete',
  'staff_user:read',
  'staff_user:update',
  'tenant_user:create',
  'tenant_user:delete',
  'tenant_user:read',
  'tenant_user:update',
  'unit:create',
  'unit:delete',
  'unit:read',
  'unit:update',
]);

/**
 * `property_manager` — manages day-to-day ops for assigned properties.
 * Cannot delete the company, cannot manage other staff accounts.
 */
const PROPERTY_MANAGER = keys([
  'announcement:broadcast',
  'announcement:create',
  'announcement:read',
  'announcement:update',
  'audit_log:read',
  'company:read',
  'contract:create',
  'contract:read',
  'contract:update',
  'invoice:create',
  'invoice:read',
  'invoice:update',
  'maintenance_ticket:approve',
  'maintenance_ticket:create',
  'maintenance_ticket:read',
  'maintenance_ticket:update',
  'meter_reading:create',
  'meter_reading:read',
  'meter_reading:update',
  'payment:approve',
  'payment:create',
  'payment:read',
  'payment:update',
  'property:read',
  'property:update',
  'slip:approve',
  'slip:read',
  'slip:update',
  'tenant_user:create',
  'tenant_user:read',
  'tenant_user:update',
  'unit:create',
  'unit:read',
  'unit:update',
]);

/**
 * `staff` — front-desk / maintenance crew. Can create meter readings and
 * maintenance tickets; cannot approve money movements or manage users.
 */
const STAFF = keys([
  'announcement:read',
  'contract:read',
  'invoice:read',
  'maintenance_ticket:create',
  'maintenance_ticket:read',
  'maintenance_ticket:update',
  'meter_reading:create',
  'meter_reading:read',
  'meter_reading:update',
  'payment:read',
  'property:read',
  'slip:read',
  'tenant_user:read',
  'unit:read',
]);

/**
 * `tenant` — the person renting a unit. Reads their own data, uploads
 * slips, submits maintenance tickets. `can` does NOT scope "own row" checks;
 * that's enforced by RLS + query filters at the API layer.
 */
const TENANT = keys([
  'announcement:read',
  'contract:read',
  'invoice:read',
  'maintenance_ticket:create',
  'maintenance_ticket:read',
  'payment:read',
  'slip:create',
  'slip:read',
  'unit:read',
]);

/**
 * `guardian` — Phase-2 role for student housing. Read-only access to the
 * linked tenant's bills and announcements.
 */
const GUARDIAN = keys([
  'announcement:read',
  'contract:read',
  'invoice:read',
  'payment:read',
]);

const MATRIX: Readonly<Record<Role, ReadonlySet<PermissionKey>>> = {
  company_owner: COMPANY_OWNER,
  property_manager: PROPERTY_MANAGER,
  staff: STAFF,
  tenant: TENANT,
  guardian: GUARDIAN,
};

// -----------------------------------------------------------------------
// Public API.
// -----------------------------------------------------------------------

/**
 * Minimal user shape accepted by {@link can}. Callers typically pass the
 * JWT claims / session object. Only `roles` is read; anything else is
 * ignored. A user with NO roles is treated as an outsider — no permissions.
 */
export type AuthUser = {
  readonly roles: readonly Role[];
};

/**
 * `true` if ANY of the user's roles grants `${resource}:${action}`.
 *
 * Multi-role union semantics — e.g. a user who is both `staff` on one
 * property and `property_manager` on another will effectively have the
 * property_manager superset while acting in the company where that role is
 * active. Scope resolution (which company / property) happens BEFORE this
 * call — pass in only the roles active for the current request.
 */
export function can(user: AuthUser, action: Action, resource: Resource): boolean {
  const key = `${resource}:${action}` as PermissionKey;
  for (const role of user.roles) {
    if (MATRIX[role].has(key)) return true;
  }
  return false;
}

/** Throws `Error` on denial — for server-side guards. */
export function assertCan(
  user: AuthUser,
  action: Action,
  resource: Resource,
): void {
  if (!can(user, action, resource)) {
    throw new Error(`Forbidden: ${action}:${resource} for roles=${user.roles.join(',')}`);
  }
}

/** Introspection helper — returns all granted permission keys for a role. */
export function permissionsFor(role: Role): readonly PermissionKey[] {
  return [...MATRIX[role]].sort();
}
