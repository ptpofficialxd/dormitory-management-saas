import { type Prisma, getTenantContext, prisma } from '@dorm/db';
import type { ListUsersQuery, UserPublic } from '@dorm/shared/zod';
import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { type CursorPage, buildCursorPage, decodeCursor } from '../../common/util/cursor.util.js';

/**
 * UserService — admin/staff user lookups (Sprint B / Task #93).
 *
 * MVP scope: LIST + GET only. No CRUD here — admin user creation lives in
 * the dev seed for now; Phase 2 will add a self-signup wizard +
 * role-assignment management UI.
 *
 * Surface:
 *   - list(query) → paginated UserPublic[] for assignee dropdown / future
 *     team page. Roles aggregated from RoleAssignment per-row (in-memory
 *     stitch — Prisma's nested include hits the same row count as a
 *     LATERAL JOIN; no N+1 because the IN-array query is one round trip).
 *   - getById(id) → single UserPublic (used by future audit-log "actor"
 *     resolution in Phase 2; left here so callers don't reach for raw
 *     prisma.user.findUnique and accidentally surface passwordHash).
 *
 * Security:
 *   - passwordHash NEVER returned (project drops it before shape return).
 *   - Email is returned (admin needs it for the dropdown label) — this is
 *     intra-company, so it's not a PII leak; admin already sees their
 *     colleagues' emails in the auth flow.
 */
@Injectable()
export class UserService {
  // ---------------------------------------------------------------
  // Read paths
  // ---------------------------------------------------------------

  /**
   * Cursor-paginated list scoped to the current company (RLS via
   * `app.company_id` in the tenant interceptor). `status` filter defaults
   * to no-filter — caller can pass `?status=active` to hide disabled users
   * from the assignee dropdown.
   */
  async list(query: ListUsersQuery): Promise<CursorPage<UserPublic>> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on user list');
    }

    const { cursor, limit, status } = query;
    const decoded = cursor ? decodeCursor(cursor) : null;

    const baseWhere: Prisma.UserWhereInput = {};
    if (status) baseWhere.status = status;

    const where: Prisma.UserWhereInput = decoded
      ? {
          AND: [
            baseWhere,
            {
              OR: [
                { createdAt: { lt: new Date(decoded.createdAt) } },
                { createdAt: new Date(decoded.createdAt), id: { lt: decoded.id } },
              ],
            },
          ],
        }
      : baseWhere;

    const rows = await prisma.user.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      // Aggregate roles inline — RoleAssignment rows scoped to current
      // company via the `companyId` filter (RLS would handle it anyway,
      // but we set it explicitly because the include shape is filtered
      // server-side, not RLS-policy-side).
      include: {
        roleAssignments: {
          where: { companyId: ctx.companyId },
          select: { role: true },
        },
      },
    });

    const projected: UserPublic[] = rows.map((row) => projectToPublic(row));
    return buildCursorPage(projected, limit);
  }

  async getById(id: string): Promise<UserPublic> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on user getById');
    }
    const row = await prisma.user.findUnique({
      where: { id },
      include: {
        roleAssignments: {
          where: { companyId: ctx.companyId },
          select: { role: true },
        },
      },
    });
    if (!row) throw new NotFoundException(`User ${id} not found`);
    return projectToPublic(row);
  }
}

/**
 * Drop sensitive fields + aggregate roles into the public view. Centralised
 * here so we never accidentally serialise `passwordHash` from a misuse of
 * `prisma.user.findUnique` — every consumer goes through `service.list` /
 * `service.getById`.
 */
function projectToPublic(row: {
  id: string;
  companyId: string;
  email: string;
  displayName: string;
  status: 'active' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
  roleAssignments: Array<{
    role: 'company_owner' | 'property_manager' | 'staff' | 'tenant' | 'guardian';
  }>;
}): UserPublic {
  return {
    id: row.id,
    companyId: row.companyId,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    roles: row.roleAssignments.map((ra) => ra.role),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
