'use client';

import type { Role } from '@dorm/shared';
import { type Action, type AuthUser, type Resource, can as sharedCan } from '@dorm/shared/rbac';
import { type ReactNode, createContext, useContext, useMemo } from 'react';

/**
 * RBAC for the admin web.
 *
 * Wraps the shared table-driven matrix from `@dorm/shared/rbac` in a React
 * Context + ergonomic hook + declarative `<Can>` gate so Client Components
 * can branch on permissions without prop-drilling claims through every layer.
 *
 * The matrix is the SINGLE SOURCE OF TRUTH (CLAUDE.md §3 #13 / §8). Never
 * hard-code `if (role === 'company_owner')` in components — always go through
 * `can(action, resource)`. Adding a new feature gate means adding a row in
 * `packages/shared/src/rbac/index.ts`, not scattering role checks.
 */

const RbacContext = createContext<AuthUser | null>(null);

export interface RbacProviderProps {
  /**
   * Roles for the current company, taken from the verified JWT claims by the
   * Server layout. A user with multiple companies has different `roles[]`
   * per company; the server already resolved the slot for `[companySlug]`.
   */
  roles: readonly Role[];
  children: ReactNode;
}

export function RbacProvider({ roles, children }: RbacProviderProps) {
  // useMemo so identity stays stable across re-renders of the layout — keeps
  // any descendant `useRole()` callers from resubscribing every render.
  const user = useMemo<AuthUser>(() => ({ roles }), [roles]);
  return <RbacContext.Provider value={user}>{children}</RbacContext.Provider>;
}

export interface UseRoleReturn {
  /** Active roles for the current company (from JWT). */
  roles: readonly Role[];
  /**
   * Table-lookup permission check — thin wrapper over the shared `can`.
   * Returns `true` when ANY of the user's roles grants `${resource}:${action}`.
   */
  can: (action: Action, resource: Resource) => boolean;
  /**
   * Sugar for "does the user hold THIS specific role?". Prefer `can()` for
   * feature gates — `hasRole` is fine for branding ("Owner Dashboard" etc.)
   * but not for security decisions.
   */
  hasRole: (role: Role) => boolean;
}

export function useRole(): UseRoleReturn {
  const user = useContext(RbacContext);
  if (!user) {
    throw new Error('useRole must be used inside <RbacProvider>');
  }
  return {
    roles: user.roles,
    can: (action, resource) => sharedCan(user, action, resource),
    hasRole: (role) => user.roles.includes(role),
  };
}

export interface CanProps {
  action: Action;
  resource: Resource;
  /** Rendered when the permission check fails. Default: nothing (null). */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Declarative permission gate. Use for "render this UI only if the user can
 * X" patterns:
 *
 *   <Can action="approve" resource="payment">
 *     <ApprovePaymentButton />
 *   </Can>
 *
 * For inline branches (e.g. filtering items inside a menu loop), prefer
 * `const { can } = useRole()` + a normal conditional — easier to compose
 * with other checks like `ready` flags.
 */
export function Can({ action, resource, fallback = null, children }: CanProps) {
  const { can } = useRole();
  return <>{can(action, resource) ? children : fallback}</>;
}
