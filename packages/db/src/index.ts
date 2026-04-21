/**
 * @dorm/db — public API.
 *
 * Consumers (apps/api, apps/web-admin server-side, BullMQ workers) import
 * from here. The generated Prisma types are re-exported so downstream code
 * never imports directly from `@prisma/client` and Prisma stays a leaf
 * dependency (CLAUDE.md §3.12 — schema is the single source of truth).
 */

export {
  Prisma,
  type Company,
  type User,
  type RoleAssignment,
  type Property,
  type Unit,
  type AuditLog,
  type CompanyStatus,
  type UserStatus,
  type UnitStatus,
  Role,
} from '@prisma/client';

export {
  prisma,
  rawPrisma,
  createTenantClient,
  createAdminClient,
  disconnect,
  type DormPrismaClient,
} from './client.js';

export {
  withTenant,
  getTenantContext,
  assertValidCompanyId,
  type TenantContext,
} from './tenant-context.js';

export { hashPassword, verifyPassword } from './password.js';
