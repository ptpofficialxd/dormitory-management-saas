import { ROLES, type Role } from '@dorm/shared';
import { type Action, type Resource, permissionsFor } from '@dorm/shared/rbac';
import { SetMetadata } from '@nestjs/common';
import { ROLES_KEY } from './roles.decorator.js';

/**
 * Matrix-driven permission decorator.
 *
 * Replaces `@Roles(...)` hard-coded role lists per CLAUDE.md §3 #13
 * ("RBAC is table-driven, never hard-code role checks"). At decoration time
 * we resolve `${resource}:${action}` against the shared RBAC matrix and
 * emit the exact set of roles that satisfy it — stored under the same
 * metadata key `RbacGuard` already reads (`'allowedRoles'`), so the guard
 * doesn't need changes.
 *
 * Example:
 *   `@Perm('create', 'property')`
 *   // → derives roles from the matrix: ['company_owner']
 *
 * Benefits over `@Roles`:
 * - Single source of truth. Edit `packages/shared/src/rbac/index.ts` and
 *   every endpoint that uses the same (action, resource) automatically
 *   picks up the new allowed-roles set. No drift possible between UI
 *   `<Can>` checks and server guards.
 * - TS-checked. `Action` and `Resource` are string-literal unions; typos
 *   fail at compile time.
 *
 * Why we reuse `@Roles`'s metadata key instead of adding a new one:
 * the guard's branching is identical ("user has ≥1 of these roles") —
 * pulling the resolved set through the existing plumbing avoids
 * duplicating RbacGuard. The `@Roles` decorator itself remains as a
 * (deprecated) escape hatch for cases where matrix doesn't fit yet.
 */
export function Perm(action: Action, resource: Resource): MethodDecorator & ClassDecorator {
  const key = `${resource}:${action}` as const;
  const allowedRoles: Role[] = ROLES.filter((role) => permissionsFor(role).includes(key));

  // Defensive: if the matrix has no role granting this permission, we'd
  // silently lock the endpoint to nobody. Fail loudly at import-time
  // instead so the developer hears about it immediately.
  if (allowedRoles.length === 0) {
    throw new Error(
      `@Perm('${action}', '${resource}'): no role grants this permission in the matrix. Add a row in packages/shared/src/rbac/index.ts or pick a different (action, resource).`,
    );
  }
  return SetMetadata(ROLES_KEY, allowedRoles);
}
