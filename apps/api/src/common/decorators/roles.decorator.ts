import type { Role } from '@dorm/shared';
import { SetMetadata } from '@nestjs/common';

/**
 * Attach allowed roles to an endpoint. `RbacGuard` reads this metadata and
 * asserts the current user holds ≥1 of the listed roles.
 *
 * @deprecated Prefer `@Perm(action, resource)` — it reads the shared RBAC
 *   matrix so role lists stay in sync with the web-admin `<Can>` gates and
 *   packages/shared tests. Hard-coded role lists via `@Roles(...)` conflict
 *   with CLAUDE.md §3 #13 ("table-driven, never hard-code role checks").
 *   Kept here as an escape hatch for the rare case where a grant truly
 *   doesn't map cleanly to an (action, resource) pair.
 *
 * Example (new code should use @Perm instead):
 *   `@Roles('company_owner', 'property_manager')`
 *
 * Leave absent = authenticated users of any role may access.
 */
export const ROLES_KEY = 'allowedRoles';
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
