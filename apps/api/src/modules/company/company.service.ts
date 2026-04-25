import { prisma } from '@dorm/db';
import { getTenantContext } from '@dorm/db';
import type { AdminJwtClaims, Company, UpdatePromptPaySettingsInput } from '@dorm/shared/zod';
import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';

/**
 * Read + minimal-mutation company operations.
 *
 * MVP scope:
 *   - Read: GET /me (current admin's profile + their company)
 *   - Read: getById (powers the Settings page)
 *   - Mutation: setPromptPay (owner-only, dedicated endpoint per
 *     `updatePromptPaySettingsInputSchema` in shared/zod)
 *
 * Other Company-row CRUD (create / rename / delete / status flip) is a
 * platform-level concern (only `super_admin` — out of MVP scope) so we
 * don't expose generic update endpoints here.
 *
 * Queries run through the shared `prisma` Proxy → `TenantContextInterceptor`
 * must have already set `app.company_id` on the active tx. Without it,
 * RLS default-denies and writes silently no-op → we'd never spot a
 * missing context bug, which is why we throw on `!ctx?.companyId`.
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

  /**
   * `GET /c/:slug/settings` payload — full company row for the Settings page
   * (includes `promptPayId` + `promptPayName` which `getMe` deliberately
   * omits to keep that hot-path response small).
   *
   * RLS scopes the query to the active company; the controller-level
   * `PathCompanyGuard` already verified the slug-vs-JWT match, so a
   * cross-company probe never reaches here. 404 on miss is an unreachable
   * defensive — kept anyway so a future bug doesn't return `undefined`.
   */
  async getCurrent(): Promise<Company> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on getCurrent');
    }
    const row = await prisma.company.findUnique({
      where: { id: ctx.companyId },
    });
    if (!row) throw new NotFoundException('Company not found');
    return row as unknown as Company;
  }

  /**
   * `PUT /c/:slug/prompt-pay` — set the company's PromptPay payee config.
   *
   * Both fields required (per `updatePromptPaySettingsInputSchema`) so a
   * half-configured QR (id without name → "Unknown Payee" in banking apps)
   * can never persist. To CLEAR the config, hit a separate DELETE endpoint
   * (out of MVP scope) — PATCH-with-null gets ambiguous semantics fast.
   *
   * RBAC enforced at the controller via `@Perm('update', 'company')` —
   * owner-only per the shared matrix. Property managers don't touch payment
   * config (it's a money-routing decision).
   *
   * Audit log: written by the global `AuditLogInterceptor` — no special
   * handling here. Resource label derives from URL → "prompt-pay".
   */
  async setPromptPay(input: UpdatePromptPaySettingsInput): Promise<Company> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on setPromptPay');
    }
    const row = await prisma.company.update({
      where: { id: ctx.companyId },
      data: {
        promptPayId: input.promptPayId,
        promptPayName: input.promptPayName,
      },
    });
    return row as unknown as Company;
  }
}
