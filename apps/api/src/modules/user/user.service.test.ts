import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for UserService.
 *
 * Coverage focus:
 *   - list aggregates roles from RoleAssignment[] and projects to public view
 *   - getById returns the same projected shape
 *   - Tenant context guard fires when companyId is absent
 *   - passwordHash is NEVER present in the projected output (security)
 */

const mockUserFindMany = vi.fn();
const mockUserFindUnique = vi.fn();
const mockGetTenantContext = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    user: {
      findMany: mockUserFindMany,
      findUnique: mockUserFindUnique,
    },
  },
  getTenantContext: mockGetTenantContext,
  Prisma: {},
}));

const { UserService } = await import('./user.service.js');

const COMPANY_ID = '11111111-1111-1111-8111-111111111111';
const USER_ID = '22222222-2222-2222-8222-222222222222';

function makeRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: USER_ID,
    companyId: COMPANY_ID,
    email: 'admin@example.com',
    displayName: 'Admin User',
    passwordHash: 'SHOULD_NEVER_LEAK',
    status: 'active' as const,
    lastLoginAt: new Date('2026-04-01T00:00:00Z'),
    createdAt: new Date('2026-04-22T00:00:00Z'),
    updatedAt: new Date('2026-04-22T00:00:00Z'),
    roleAssignments: [{ role: 'company_owner' as const }, { role: 'staff' as const }],
    ...overrides,
  };
}

describe('UserService', () => {
  let service: InstanceType<typeof UserService>;

  beforeEach(() => {
    mockUserFindMany.mockReset();
    mockUserFindUnique.mockReset();
    mockGetTenantContext.mockReset();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });
    service = new UserService();
  });

  // =====================================================================
  // list
  // =====================================================================

  it('returns paginated UserPublic[] with roles aggregated from RoleAssignment', async () => {
    mockUserFindMany.mockResolvedValueOnce([makeRow()]);

    const out = await service.list({ limit: 20 });

    expect(out.items).toHaveLength(1);
    const user = out.items[0];
    expect(user).toBeDefined();
    if (!user) return; // narrow for TS
    expect(user.id).toBe(USER_ID);
    expect(user.email).toBe('admin@example.com');
    expect(user.displayName).toBe('Admin User');
    expect(user.status).toBe('active');
    expect(user.roles).toEqual(['company_owner', 'staff']);
  });

  it('NEVER exposes passwordHash in the projected output', async () => {
    mockUserFindMany.mockResolvedValueOnce([makeRow()]);

    const out = await service.list({ limit: 20 });

    const serialized = JSON.stringify(out.items);
    expect(serialized).not.toContain('SHOULD_NEVER_LEAK');
    expect(serialized).not.toContain('passwordHash');
  });

  it('passes status filter through to the prisma where clause', async () => {
    mockUserFindMany.mockResolvedValueOnce([]);

    await service.list({ status: 'active', limit: 20 });

    // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
    const args = mockUserFindMany.mock.calls[0]![0];
    expect(args.where).toEqual({ status: 'active' });
  });

  it('scopes the role include to the current company', async () => {
    mockUserFindMany.mockResolvedValueOnce([]);

    await service.list({ limit: 20 });

    // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
    const args = mockUserFindMany.mock.calls[0]![0];
    expect(args.include.roleAssignments.where).toEqual({ companyId: COMPANY_ID });
  });

  it('throws InternalServerErrorException when tenant context is missing', async () => {
    mockGetTenantContext.mockReturnValueOnce(undefined);
    await expect(service.list({ limit: 20 })).rejects.toThrow(InternalServerErrorException);
  });

  // =====================================================================
  // getById
  // =====================================================================

  it('getById returns projected UserPublic on hit', async () => {
    mockUserFindUnique.mockResolvedValueOnce(makeRow());

    const out = await service.getById(USER_ID);

    expect(out.id).toBe(USER_ID);
    expect(out.roles).toEqual(['company_owner', 'staff']);
    // biome-ignore lint/suspicious/noExplicitAny: defensive runtime check
    expect((out as any).passwordHash).toBeUndefined();
  });

  it('getById throws NotFoundException on miss', async () => {
    mockUserFindUnique.mockResolvedValueOnce(null);
    await expect(service.getById(USER_ID)).rejects.toThrow(NotFoundException);
  });
});
