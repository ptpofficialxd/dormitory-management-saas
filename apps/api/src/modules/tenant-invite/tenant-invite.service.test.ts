import {
  ConflictException,
  GoneException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for TenantInviteService — mocks `@dorm/db` so we exercise the
 * security-critical paths without spinning a real Postgres:
 *
 *   generate     : 404 missing tenant / 409 already bound / happy path
 *                  (companyId stamped from tenant context, plaintext returned ONCE,
 *                   audit row emitted with codePrefix + expiresAt).
 *   list         : take=limit+1, orderBy [createdAt desc, id desc], status filter
 *                  AND-combines with cursor keyset.
 *   revoke       : CAS pending→revoked / 410 if not pending / lost-race 410
 *                  / audit row carries reason metadata.
 *   peek         : 404 unknown code / 410 expired (with opportunistic sweep)
 *                  / 410 terminal status / redacted preview shape (multibyte safe).
 *   redeem       : happy path (CAS + bind + audit) / idempotent retry
 *                  / 409 BIND_CONFLICT (with rollback + audit) / 409 race-lost CAS
 *                  / 410 expired / 404 unknown code.
 *
 * RLS isolation + pgcrypto round-trips are covered by the e2e suite (Postgres-only).
 */

const mockTenantInviteFindFirst = vi.fn();
const mockTenantInviteFindUnique = vi.fn();
const mockTenantInviteFindUniqueOrThrow = vi.fn();
const mockTenantInviteFindMany = vi.fn();
const mockTenantInviteCreate = vi.fn();
const mockTenantInviteUpdateMany = vi.fn();
const mockTenantFindUnique = vi.fn();
const mockTenantUpdate = vi.fn();
const mockAuditLogCreate = vi.fn();
const mockGetTenantContext = vi.fn();
const mockWithTenant = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    tenantInvite: {
      findFirst: mockTenantInviteFindFirst,
      findUnique: mockTenantInviteFindUnique,
      findUniqueOrThrow: mockTenantInviteFindUniqueOrThrow,
      findMany: mockTenantInviteFindMany,
      create: mockTenantInviteCreate,
      updateMany: mockTenantInviteUpdateMany,
    },
    tenant: {
      findUnique: mockTenantFindUnique,
      update: mockTenantUpdate,
    },
    auditLog: {
      create: mockAuditLogCreate,
    },
  },
  getTenantContext: mockGetTenantContext,
  withTenant: mockWithTenant,
  Prisma: {},
}));

const { TenantInviteService } = await import('./tenant-invite.service.js');

const COMPANY_ID = '22222222-2222-2222-8222-222222222222';
const OTHER_COMPANY_ID = '33333333-3333-3333-8333-333333333333';
const TENANT_ID = '55555555-5555-5555-8555-555555555555';
const INVITE_ID = '77777777-7777-7777-8777-777777777777';
const ACTOR_USER_ID = '99999999-9999-9999-8999-999999999999';
const LINE_USER_ID = 'U-1234567890abcdef';
const OTHER_LINE_USER_ID = 'U-fedcba0987654321';

// Realistic 8-char Crockford code from the alphabet (no I, L, O, U).
const PLAINTEXT_CODE = 'K7M3XQ2P';
const CODE_PREFIX = 'K7M3';
// Placeholder codeHash for mock rows — these tests never assert hash equality
// against PLAINTEXT_CODE because the prisma boundary is mocked; the mock just
// returns whatever shape we hand it. Real hash round-trip lives in the e2e suite.
const PLACEHOLDER_CODE_HASH = '0'.repeat(64);

/**
 * Helper to build a Prisma-shaped TenantInvite row. Tests override only the
 * fields they care about — defaults match the "fresh, pending" happy path.
 */
function makeInviteRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: INVITE_ID,
    companyId: COMPANY_ID,
    tenantId: TENANT_ID,
    codeHash: PLACEHOLDER_CODE_HASH,
    codePrefix: CODE_PREFIX,
    status: 'pending',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    redeemedAt: null,
    redeemedByLineUserId: null,
    createdAt: new Date('2026-04-22T00:00:00.000Z'),
    createdByUserId: ACTOR_USER_ID,
    ...overrides,
  };
}

describe('TenantInviteService', () => {
  let service: InstanceType<typeof TenantInviteService>;

  beforeEach(() => {
    mockTenantInviteFindFirst.mockReset();
    mockTenantInviteFindUnique.mockReset();
    mockTenantInviteFindUniqueOrThrow.mockReset();
    mockTenantInviteFindMany.mockReset();
    mockTenantInviteCreate.mockReset();
    mockTenantInviteUpdateMany.mockReset();
    mockTenantFindUnique.mockReset();
    mockTenantUpdate.mockReset();
    mockAuditLogCreate.mockReset();
    mockGetTenantContext.mockReset();
    mockWithTenant.mockReset();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });
    // Default: withTenant just runs the inner fn (RLS is mocked at the prisma boundary anyway).
    mockWithTenant.mockImplementation(async (_ctx: unknown, fn: () => Promise<unknown>) => fn());
    mockAuditLogCreate.mockResolvedValue({ id: 'audit-row' });
    service = new TenantInviteService();
  });

  // ------------------------------------------------------------------
  // generate
  // ------------------------------------------------------------------

  describe('generate', () => {
    it('throws InternalServerError when tenant context is missing', async () => {
      mockGetTenantContext.mockReturnValueOnce(null);
      await expect(service.generate(TENANT_ID, ACTOR_USER_ID)).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(mockTenantFindUnique).not.toHaveBeenCalled();
      expect(mockTenantInviteCreate).not.toHaveBeenCalled();
    });

    it('throws NotFound when the tenant does not exist in scope', async () => {
      mockTenantFindUnique.mockResolvedValueOnce(null);
      await expect(service.generate(TENANT_ID, ACTOR_USER_ID)).rejects.toThrow(NotFoundException);
      expect(mockTenantInviteCreate).not.toHaveBeenCalled();
      expect(mockAuditLogCreate).not.toHaveBeenCalled();
    });

    it('throws Conflict when tenant is already bound to a LINE user', async () => {
      mockTenantFindUnique.mockResolvedValueOnce({
        id: TENANT_ID,
        lineUserId: 'U-already-bound',
      });
      await expect(service.generate(TENANT_ID, ACTOR_USER_ID)).rejects.toThrow(ConflictException);
      expect(mockTenantInviteCreate).not.toHaveBeenCalled();
      expect(mockAuditLogCreate).not.toHaveBeenCalled();
    });

    it('mints a fresh invite, returns plaintext display form ONCE, and audits', async () => {
      mockTenantFindUnique.mockResolvedValueOnce({ id: TENANT_ID, lineUserId: null });
      mockTenantInviteCreate.mockImplementationOnce(async (args: unknown) => {
        const data = (args as { data: Record<string, unknown> }).data;
        return {
          ...makeInviteRow(),
          codePrefix: data.codePrefix as string,
          codeHash: data.codeHash as string,
          expiresAt: data.expiresAt as Date,
          createdByUserId: data.createdByUserId as string,
        };
      });

      const out = await service.generate(TENANT_ID, ACTOR_USER_ID);

      // Plaintext return shape: 8 chars + mid-hyphen → 9 chars total.
      expect(out.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(out.code).toHaveLength(9);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockImplementationOnce resolution
      const createArgs = mockTenantInviteCreate.mock.calls[0]![0];
      // companyId stamped from tenant context — never trusted from caller.
      expect(createArgs.data.companyId).toBe(COMPANY_ID);
      expect(createArgs.data.tenantId).toBe(TENANT_ID);
      expect(createArgs.data.status).toBe('pending');
      expect(createArgs.data.createdByUserId).toBe(ACTOR_USER_ID);
      // codeHash is SHA-256 hex (lowercase, 64 chars).
      expect(createArgs.data.codeHash).toMatch(/^[0-9a-f]{64}$/);
      // codePrefix is 4 chars from the Crockford alphabet.
      expect(createArgs.data.codePrefix).toHaveLength(4);
      expect(createArgs.data.codePrefix).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}$/);
      // expiresAt is ~7 days in the future (allow ±5s for test clock skew).
      const ttlMs = createArgs.data.expiresAt.getTime() - Date.now();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      expect(Math.abs(ttlMs - sevenDays)).toBeLessThan(5_000);

      // Audit row written with codePrefix + tenantId + expiresAt (no plaintext).
      expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
      // biome-ignore lint/style/noNonNullAssertion: call asserted by toHaveBeenCalledTimes(1) above
      const auditArgs = mockAuditLogCreate.mock.calls[0]![0];
      expect(auditArgs.data.action).toBe('TENANT_INVITE_GENERATED');
      expect(auditArgs.data.resource).toBe('tenant_invite');
      expect(auditArgs.data.resourceId).toBe(INVITE_ID);
      expect(auditArgs.data.actorUserId).toBe(ACTOR_USER_ID);
      expect(auditArgs.data.metadata.tenantId).toBe(TENANT_ID);
      expect(auditArgs.data.metadata.codePrefix).toBe(createArgs.data.codePrefix);
      // Plaintext code MUST NOT appear anywhere in audit metadata.
      const metadataStr = JSON.stringify(auditArgs.data.metadata);
      expect(metadataStr).not.toContain(out.code.replace('-', ''));
    });
  });

  // ------------------------------------------------------------------
  // list
  // ------------------------------------------------------------------

  describe('list', () => {
    it('queries with take=limit+1 and orderBy [createdAt desc, id desc]', async () => {
      mockTenantInviteFindMany.mockResolvedValueOnce([]);
      await service.list(TENANT_ID, { limit: 20 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockTenantInviteFindMany.mock.calls[0]![0];
      expect(args.take).toBe(21);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.where).toEqual({ tenantId: TENANT_ID });
    });

    it('applies status filter without cursor', async () => {
      mockTenantInviteFindMany.mockResolvedValueOnce([]);
      await service.list(TENANT_ID, { limit: 20, status: 'pending' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockTenantInviteFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({ tenantId: TENANT_ID, status: 'pending' });
    });

    it('AND-combines status filter with cursor keyset', async () => {
      mockTenantInviteFindMany.mockResolvedValueOnce([]);
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: '2026-04-15T00:00:00.000Z', id: INVITE_ID }),
        'utf8',
      ).toString('base64url');

      await service.list(TENANT_ID, { cursor, status: 'pending', limit: 10 });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const args = mockTenantInviteFindMany.mock.calls[0]![0];
      expect(args.where).toEqual({
        AND: [
          { tenantId: TENANT_ID, status: 'pending' },
          {
            OR: [
              { createdAt: { lt: new Date('2026-04-15T00:00:00.000Z') } },
              { createdAt: new Date('2026-04-15T00:00:00.000Z'), id: { lt: INVITE_ID } },
            ],
          },
        ],
      });
    });

    it('returns mapped TenantInvite rows', async () => {
      mockTenantInviteFindMany.mockResolvedValueOnce([
        makeInviteRow({ id: INVITE_ID, status: 'redeemed' }),
      ]);
      const page = await service.list(TENANT_ID, { limit: 20 });
      expect(page.items).toHaveLength(1);
      // biome-ignore lint/style/noNonNullAssertion: items[0] guaranteed by toHaveLength(1) above
      expect(page.items[0]!.id).toBe(INVITE_ID);
      // biome-ignore lint/style/noNonNullAssertion: items[0] guaranteed by toHaveLength(1) above
      expect(page.items[0]!.status).toBe('redeemed');
      // codeHash MUST NOT leak into the public shape.
      expect((page.items[0] as Record<string, unknown>).codeHash).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // revoke
  // ------------------------------------------------------------------

  describe('revoke', () => {
    it('throws InternalServerError when tenant context is missing', async () => {
      mockGetTenantContext.mockReturnValueOnce(null);
      await expect(service.revoke(INVITE_ID, { reason: 'test' }, ACTOR_USER_ID)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws NotFound when invite does not exist', async () => {
      mockTenantInviteFindUnique.mockResolvedValueOnce(null);
      await expect(service.revoke(INVITE_ID, {}, ACTOR_USER_ID)).rejects.toThrow(NotFoundException);
      expect(mockTenantInviteUpdateMany).not.toHaveBeenCalled();
    });

    it('throws 410 Gone when invite is already in a terminal state', async () => {
      mockTenantInviteFindUnique.mockResolvedValueOnce(makeInviteRow({ status: 'redeemed' }));
      await expect(service.revoke(INVITE_ID, {}, ACTOR_USER_ID)).rejects.toThrow(GoneException);
      expect(mockTenantInviteUpdateMany).not.toHaveBeenCalled();
    });

    it('throws 410 Gone when the CAS race is lost (count=0)', async () => {
      mockTenantInviteFindUnique.mockResolvedValueOnce(makeInviteRow());
      mockTenantInviteUpdateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.revoke(INVITE_ID, {}, ACTOR_USER_ID)).rejects.toThrow(GoneException);
      // Must NOT audit a revoke that didn't actually happen.
      expect(mockAuditLogCreate).not.toHaveBeenCalled();
    });

    it('CAS-flips pending→revoked and audits with reason metadata', async () => {
      mockTenantInviteFindUnique.mockResolvedValueOnce(makeInviteRow());
      mockTenantInviteUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockTenantInviteFindUniqueOrThrow.mockResolvedValueOnce(makeInviteRow({ status: 'revoked' }));

      const out = await service.revoke(
        INVITE_ID,
        { reason: 'tenant lost the code' },
        ACTOR_USER_ID,
      );

      expect(out.status).toBe('revoked');

      // CAS scoped to status='pending' so two simultaneous revokes can't both win.
      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce resolution
      const updateArgs = mockTenantInviteUpdateMany.mock.calls[0]![0];
      expect(updateArgs.where).toEqual({ id: INVITE_ID, status: 'pending' });
      expect(updateArgs.data).toEqual({ status: 'revoked' });

      expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
      // biome-ignore lint/style/noNonNullAssertion: call asserted by toHaveBeenCalledTimes(1) above
      const auditArgs = mockAuditLogCreate.mock.calls[0]![0];
      expect(auditArgs.data.action).toBe('TENANT_INVITE_REVOKED');
      expect(auditArgs.data.actorUserId).toBe(ACTOR_USER_ID);
      expect(auditArgs.data.metadata.reason).toBe('tenant lost the code');
      expect(auditArgs.data.metadata.tenantId).toBe(TENANT_ID);
      expect(auditArgs.data.metadata.codePrefix).toBe(CODE_PREFIX);
    });

    it('records null reason when admin omits it', async () => {
      mockTenantInviteFindUnique.mockResolvedValueOnce(makeInviteRow());
      mockTenantInviteUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockTenantInviteFindUniqueOrThrow.mockResolvedValueOnce(makeInviteRow({ status: 'revoked' }));

      await service.revoke(INVITE_ID, {}, ACTOR_USER_ID);

      // biome-ignore lint/style/noNonNullAssertion: revoke happy path always emits one audit row
      const auditArgs = mockAuditLogCreate.mock.calls[0]![0];
      expect(auditArgs.data.metadata.reason).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // peek
  // ------------------------------------------------------------------

  describe('peek', () => {
    it('throws NotFound when no invite matches the code (no enumeration)', async () => {
      mockTenantInviteFindFirst.mockResolvedValueOnce(null);
      await expect(service.peek(PLAINTEXT_CODE)).rejects.toThrow(NotFoundException);
      // Lookup MUST go through bypass-RLS withTenant scope.
      expect(mockWithTenant).toHaveBeenCalled();
      // biome-ignore lint/style/noNonNullAssertion: call asserted by toHaveBeenCalled() above
      const ctxArg = mockWithTenant.mock.calls[0]![0];
      expect(ctxArg).toEqual({ companyId: '', bypassRls: true });
    });

    it('throws 410 Gone when invite is in a terminal state', async () => {
      mockTenantInviteFindFirst.mockResolvedValueOnce({
        ...makeInviteRow({ status: 'revoked' }),
        tenant: { id: TENANT_ID, displayName: 'Test', contracts: [] },
      });
      await expect(service.peek(PLAINTEXT_CODE)).rejects.toThrow(GoneException);
    });

    it('opportunistically sweeps an expired pending invite then 410s', async () => {
      mockTenantInviteFindFirst.mockResolvedValueOnce({
        ...makeInviteRow({
          status: 'pending',
          expiresAt: new Date(Date.now() - 60_000), // 1 min ago
        }),
        tenant: { id: TENANT_ID, displayName: 'Test', contracts: [] },
      });
      mockTenantInviteUpdateMany.mockResolvedValueOnce({ count: 1 });

      await expect(service.peek(PLAINTEXT_CODE)).rejects.toThrow(GoneException);

      // Opportunistic sweep ran inside the row's company scope (NOT bypass-RLS).
      expect(mockWithTenant).toHaveBeenCalledTimes(2);
      // biome-ignore lint/style/noNonNullAssertion: call asserted by toHaveBeenCalledTimes(2) above
      const sweepCtx = mockWithTenant.mock.calls[1]![0];
      expect(sweepCtx).toEqual({ companyId: COMPANY_ID });

      // biome-ignore lint/style/noNonNullAssertion: sweep updateMany must have run if 410 was thrown
      const sweepArgs = mockTenantInviteUpdateMany.mock.calls[0]![0];
      expect(sweepArgs.where).toEqual({ id: INVITE_ID, status: 'pending' });
      expect(sweepArgs.data).toEqual({ status: 'expired' });
    });

    it('returns redacted preview with multibyte-safe Thai display name', async () => {
      mockTenantInviteFindFirst.mockResolvedValueOnce({
        ...makeInviteRow(),
        tenant: {
          id: TENANT_ID,
          displayName: 'ก. สมชาย ใจดี',
          contracts: [
            {
              unit: {
                unitNumber: '305',
                property: { name: 'อาคาร A' },
              },
            },
          ],
        },
      });

      const out = await service.peek(PLAINTEXT_CODE);
      expect(out.inviteId).toBe(INVITE_ID);
      // First Thai codepoint preserved, rest masked. Crucially NOT a mid-byte slice.
      expect(out.tenantDisplayHint).toBe('ก****');
      expect(out.unitNumber).toBe('305');
      expect(out.propertyName).toBe('อาคาร A');
      // Tenant id MUST NOT leak into peek response (only inviteId is exposed).
      expect((out as Record<string, unknown>).tenantId).toBeUndefined();
    });

    it('returns nulls for unit/property when tenant has no active contract', async () => {
      mockTenantInviteFindFirst.mockResolvedValueOnce({
        ...makeInviteRow(),
        tenant: { id: TENANT_ID, displayName: 'Solo Tenant', contracts: [] },
      });
      const out = await service.peek(PLAINTEXT_CODE);
      expect(out.unitNumber).toBeNull();
      expect(out.propertyName).toBeNull();
      expect(out.tenantDisplayHint).toBe('S****');
    });
  });

  // ------------------------------------------------------------------
  // redeem
  // ------------------------------------------------------------------

  describe('redeem', () => {
    it('throws NotFound when no invite matches the code', async () => {
      mockTenantInviteFindFirst.mockResolvedValueOnce(null);
      await expect(service.redeem(PLAINTEXT_CODE, LINE_USER_ID)).rejects.toThrow(NotFoundException);
      expect(mockTenantUpdate).not.toHaveBeenCalled();
      expect(mockAuditLogCreate).not.toHaveBeenCalled();
    });

    it('idempotent retry — same line user re-redeems an already-redeemed invite', async () => {
      const redeemedAt = new Date('2026-04-22T10:00:00.000Z');
      mockTenantInviteFindFirst.mockResolvedValueOnce(
        makeInviteRow({
          status: 'redeemed',
          redeemedAt,
          redeemedByLineUserId: LINE_USER_ID,
        }),
      );

      const out = await service.redeem(PLAINTEXT_CODE, LINE_USER_ID);
      expect(out.tenantId).toBe(TENANT_ID);
      expect(out.companyId).toBe(COMPANY_ID);
      expect(out.redeemedAt).toEqual(redeemedAt);

      // No mutation, no audit row, no withTenant for mutate side.
      expect(mockTenantInviteUpdateMany).not.toHaveBeenCalled();
      expect(mockTenantUpdate).not.toHaveBeenCalled();
      expect(mockAuditLogCreate).not.toHaveBeenCalled();
      // Only the bypass-RLS lookup ran.
      expect(mockWithTenant).toHaveBeenCalledTimes(1);
    });

    it('throws 410 Gone when a different line user already redeemed', async () => {
      mockTenantInviteFindFirst.mockResolvedValueOnce(
        makeInviteRow({
          status: 'redeemed',
          redeemedAt: new Date('2026-04-22T10:00:00.000Z'),
          redeemedByLineUserId: OTHER_LINE_USER_ID,
        }),
      );

      await expect(service.redeem(PLAINTEXT_CODE, LINE_USER_ID)).rejects.toThrow(GoneException);
    });

    it('opportunistically sweeps an expired pending invite then 410s', async () => {
      mockTenantInviteFindFirst.mockResolvedValueOnce(
        makeInviteRow({
          status: 'pending',
          expiresAt: new Date(Date.now() - 60_000),
        }),
      );
      mockTenantInviteUpdateMany.mockResolvedValueOnce({ count: 1 });

      await expect(service.redeem(PLAINTEXT_CODE, LINE_USER_ID)).rejects.toThrow(GoneException);
      expect(mockTenantUpdate).not.toHaveBeenCalled();
    });

    it('happy path — CAS flips invite, binds tenant.lineUserId, audits', async () => {
      mockTenantInviteFindFirst.mockResolvedValueOnce(makeInviteRow());
      mockTenantInviteUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockTenantUpdate.mockResolvedValueOnce({ id: TENANT_ID, lineUserId: LINE_USER_ID });

      const out = await service.redeem(PLAINTEXT_CODE, LINE_USER_ID);
      expect(out.tenantId).toBe(TENANT_ID);
      expect(out.companyId).toBe(COMPANY_ID);
      expect(out.redeemedAt).toBeInstanceOf(Date);

      // CAS asserted to be scoped to status='pending'.
      // biome-ignore lint/style/noNonNullAssertion: CAS must have run if happy-path returned
      const casArgs = mockTenantInviteUpdateMany.mock.calls[0]![0];
      expect(casArgs.where).toEqual({ id: INVITE_ID, status: 'pending' });
      expect(casArgs.data.status).toBe('redeemed');
      expect(casArgs.data.redeemedByLineUserId).toBe(LINE_USER_ID);
      expect(casArgs.data.redeemedAt).toBeInstanceOf(Date);

      // Tenant binding goes to the SAME tenantId from the invite.
      // biome-ignore lint/style/noNonNullAssertion: tenant.update must have run if happy-path returned
      const tenantArgs = mockTenantUpdate.mock.calls[0]![0];
      expect(tenantArgs.where).toEqual({ id: TENANT_ID });
      expect(tenantArgs.data).toEqual({ lineUserId: LINE_USER_ID });

      // Mutate side ran inside the invite's company scope.
      // biome-ignore lint/style/noNonNullAssertion: redeem opens a second withTenant for mutate side
      const mutateCtx = mockWithTenant.mock.calls[1]![0];
      expect(mutateCtx).toEqual({ companyId: COMPANY_ID });

      // Audit row carries lineUserId in metadata, actorUserId is null (public path).
      expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
      // biome-ignore lint/style/noNonNullAssertion: call asserted by toHaveBeenCalledTimes(1) above
      const auditArgs = mockAuditLogCreate.mock.calls[0]![0];
      expect(auditArgs.data.action).toBe('TENANT_INVITE_REDEEMED');
      expect(auditArgs.data.actorUserId).toBeNull();
      expect(auditArgs.data.metadata.lineUserId).toBe(LINE_USER_ID);
      expect(auditArgs.data.metadata.tenantId).toBe(TENANT_ID);
      expect(auditArgs.data.metadata.codePrefix).toBe(CODE_PREFIX);
    });

    it('throws 409 ConflictException when CAS race is lost', async () => {
      mockTenantInviteFindFirst.mockResolvedValueOnce(makeInviteRow());
      mockTenantInviteUpdateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.redeem(PLAINTEXT_CODE, LINE_USER_ID)).rejects.toThrow(ConflictException);
      expect(mockTenantUpdate).not.toHaveBeenCalled();
      expect(mockAuditLogCreate).not.toHaveBeenCalled();
    });

    it('BIND_CONFLICT — rolls back invite, audits, throws 409', async () => {
      mockTenantInviteFindFirst.mockResolvedValueOnce(makeInviteRow());
      // First updateMany = CAS flip (succeeds).
      // Second updateMany = rollback (succeeds).
      mockTenantInviteUpdateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });

      const p2002 = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['companyId', 'lineUserId'] },
      });
      mockTenantUpdate.mockRejectedValueOnce(p2002);

      await expect(service.redeem(PLAINTEXT_CODE, LINE_USER_ID)).rejects.toThrow(ConflictException);

      // Two updateMany calls: one CAS forward, one rollback.
      expect(mockTenantInviteUpdateMany).toHaveBeenCalledTimes(2);
      // biome-ignore lint/style/noNonNullAssertion: call asserted by toHaveBeenCalledTimes(2) above
      const rollbackArgs = mockTenantInviteUpdateMany.mock.calls[1]![0];
      expect(rollbackArgs.where).toEqual({ id: INVITE_ID, status: 'redeemed' });
      expect(rollbackArgs.data).toEqual({
        status: 'pending',
        redeemedAt: null,
        redeemedByLineUserId: null,
      });

      // Audit row uses BIND_CONFLICT action with the conflicting lineUserId.
      expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
      // biome-ignore lint/style/noNonNullAssertion: call asserted by toHaveBeenCalledTimes(1) above
      const auditArgs = mockAuditLogCreate.mock.calls[0]![0];
      expect(auditArgs.data.action).toBe('TENANT_INVITE_BIND_CONFLICT');
      expect(auditArgs.data.actorUserId).toBeNull();
      expect(auditArgs.data.metadata.lineUserId).toBe(LINE_USER_ID);
      expect(auditArgs.data.metadata.tenantId).toBe(TENANT_ID);
    });

    it('non-P2002 errors from tenant.update bubble up unchanged', async () => {
      mockTenantInviteFindFirst.mockResolvedValueOnce(makeInviteRow());
      mockTenantInviteUpdateMany.mockResolvedValueOnce({ count: 1 });
      const dbDown = new Error('connection terminated');
      mockTenantUpdate.mockRejectedValueOnce(dbDown);

      await expect(service.redeem(PLAINTEXT_CODE, LINE_USER_ID)).rejects.toThrow(
        'connection terminated',
      );
      // No rollback, no audit — let the unexpected error surface.
      expect(mockTenantInviteUpdateMany).toHaveBeenCalledTimes(1);
      expect(mockAuditLogCreate).not.toHaveBeenCalled();
    });

    it('opens the mutate-side withTenant with the INVITE row companyId, not the lookup default', async () => {
      mockTenantInviteFindFirst.mockResolvedValueOnce(
        makeInviteRow({ companyId: OTHER_COMPANY_ID }),
      );
      mockTenantInviteUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockTenantUpdate.mockResolvedValueOnce({ id: TENANT_ID, lineUserId: LINE_USER_ID });

      await service.redeem(PLAINTEXT_CODE, LINE_USER_ID);

      // Lookup ctx (call 0) is bypass-RLS; mutate ctx (call 1) is the row's company.
      // biome-ignore lint/style/noNonNullAssertion: vitest mock.calls indexed access — guaranteed populated.
      expect(mockWithTenant.mock.calls[0]![0]).toEqual({ companyId: '', bypassRls: true });
      // biome-ignore lint/style/noNonNullAssertion: vitest mock.calls indexed access — guaranteed populated.
      expect(mockWithTenant.mock.calls[1]![0]).toEqual({ companyId: OTHER_COMPANY_ID });
    });
  });
});
