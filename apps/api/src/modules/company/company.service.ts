import { prisma } from '@dorm/db';
import type { AdminJwtClaims } from '@dorm/shared/zod';
import { Injectable, NotFoundException } from '@nestjs/common';

/**
 * Read-only company operations for MVP. CRUD on Company is a platform-level
 * concern (only `super_admin` — out of scope for MVP) so we don't expose
 * update/delete endpoints here.
 *
 * Queries run through the shared `prisma` Proxy, so `TenantContextInterceptor`
 * must have already set `app.company_id` on the active tx. Without that, RLS
 * will default-deny and the query returns null — which we surface as 404.
 */
@Injectable()
export class CompanyService {
  /**
   * `GET /me` payload — current user's profile + their company, with the
   * role list embedded from the JWT claims so the frontend can render the
   * nav without an extra round-trip.
   */
  async getMe(claims: AdminJwtClaims) {
    const [company, user] = await Promise.all([
      prisma.company.findUnique({
        where: { id: claims.companyId },
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
        },
      }),
      prisma.user.findUnique({
        where: { id: claims.sub },
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          lastLoginAt: true,
        },
      }),
    ]);

    if (!company || !user) {
      // Either the tenant context is wrong (RLS hid the rows) or the user
      // was deleted between token-issue and now. Return 404 to avoid leaking
      // details; client should force a re-login.
      throw new NotFoundException('Profile not found');
    }

    return {
      company,
      user,
      roles: claims.roles,
    };
  }
}
