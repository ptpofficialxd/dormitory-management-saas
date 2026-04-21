import type { Role } from '@dorm/shared';
import { SetMetadata } from '@nestjs/common';

/**
 * Attach allowed roles to an endpoint. `RbacGuard` reads this metadata and
 * asserts the current user holds ≥1 of the listed roles.
 *
 * Example:
 *   `@Roles('company_owner', 'property_manager')`
 *
 * Leave absent = authenticated users of any role may access.
 */
export const ROLES_KEY = 'allowedRoles';
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
