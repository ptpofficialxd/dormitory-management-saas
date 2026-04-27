import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for MaintenanceService — mocks `@dorm/db` + StorageService.
 *
 * Coverage focus:
 *   - createForTenant: auto-derive unitId from active contract; reject when
 *     no active contract; photo prefix + R2 HEAD validation
 *   - update state machine: every from→to transition that should pass +
 *     every one that should 409; resolved/cancelled require resolutionNote;
 *     reopen clears resolvedAt
 *   - getByIdForTenant: cross-tenant probes return 404
 *   - createPhotoUploadUrl: key prefix is tenant-scoped
 *   - getPhotoViewUrl: rejects keys not in the ticket's photoR2Keys array
 */

const mockMaintenanceFindUnique = vi.fn();
const mockMaintenanceFindFirst = vi.fn();
const mockMaintenanceFindMany = vi.fn();
const mockMaintenanceCreate = vi.fn();
const mockMaintenanceUpdate = vi.fn();
const mockContractFindFirst = vi.fn();
const mockUserFindUnique = vi.fn();
const mockGetTenantContext = vi.fn();

vi.mock('@dorm/db', () => ({
  prisma: {
    maintenanceRequest: {
      findUnique: mockMaintenanceFindUnique,
      findFirst: mockMaintenanceFindFirst,
      findMany: mockMaintenanceFindMany,
      create: mockMaintenanceCreate,
      update: mockMaintenanceUpdate,
    },
    contract: { findFirst: mockContractFindFirst },
    user: { findUnique: mockUserFindUnique },
  },
  getTenantContext: mockGetTenantContext,
  Prisma: {},
}));

const { MaintenanceService } = await import('./maintenance.service.js');

const COMPANY_ID = '11111111-1111-1111-8111-111111111111';
const TICKET_ID = '22222222-2222-2222-8222-222222222222';
const TENANT_ID = '33333333-3333-3333-8333-333333333333';
const OTHER_TENANT_ID = '44444444-4444-4444-8444-444444444444';
const UNIT_ID = '55555555-5555-5555-8555-555555555555';
const ASSIGNEE_USER_ID = '66666666-6666-6666-8666-666666666666';
const VALID_PHOTO_KEY = `companies/${COMPANY_ID}/maintenance/${TENANT_ID}/abc.jpg`;
const FOREIGN_PHOTO_KEY = `companies/${COMPANY_ID}/maintenance/${OTHER_TENANT_ID}/abc.jpg`;

class FakeStorageService {
  generateUploadUrl = vi.fn();
  generateDownloadUrl = vi.fn();
  headObject = vi.fn();
}

describe('MaintenanceService', () => {
  let service: InstanceType<typeof MaintenanceService>;
  let storage: FakeStorageService;

  beforeEach(() => {
    mockMaintenanceFindUnique.mockReset();
    mockMaintenanceFindFirst.mockReset();
    mockMaintenanceFindMany.mockReset();
    mockMaintenanceCreate.mockReset();
    mockMaintenanceUpdate.mockReset();
    mockContractFindFirst.mockReset();
    mockUserFindUnique.mockReset();
    mockGetTenantContext.mockReset();
    mockGetTenantContext.mockReturnValue({ companyId: COMPANY_ID });

    storage = new FakeStorageService();
    // biome-ignore lint/suspicious/noExplicitAny: structural typing across test boundary
    service = new MaintenanceService(storage as any);
  });

  // =====================================================================
  // createForTenant
  // =====================================================================

  describe('createForTenant', () => {
    it('auto-derives unitId from the tenant active contract + persists ticket', async () => {
      mockContractFindFirst.mockResolvedValueOnce({ id: 'ctr-1', unitId: UNIT_ID });
      storage.headObject.mockResolvedValueOnce({ contentLength: 100 });
      mockMaintenanceCreate.mockResolvedValueOnce({ id: TICKET_ID, unitId: UNIT_ID });

      await service.createForTenant(
        {
          unitId: 'ignored-by-service',
          category: 'plumbing',
          title: 'น้ำรั่ว',
          description: 'ก๊อกห้องน้ำ',
          priority: 'normal',
          photoR2Keys: [VALID_PHOTO_KEY],
        },
        TENANT_ID,
      );

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockMaintenanceCreate.mock.calls[0]![0];
      // unitId comes from the contract, NOT from the input — defends against
      // tenant guessing a sibling's unitId.
      expect(args.data.unitId).toBe(UNIT_ID);
      expect(args.data.tenantId).toBe(TENANT_ID);
      expect(args.data.companyId).toBe(COMPANY_ID);
      expect(args.data.status).toBe('open');
      expect(args.data.photoR2Keys).toEqual([VALID_PHOTO_KEY]);
    });

    it('rejects with NoActiveContract when tenant has no active contract', async () => {
      mockContractFindFirst.mockResolvedValueOnce(null);

      await expect(
        service.createForTenant(
          {
            unitId: UNIT_ID,
            category: 'plumbing',
            title: 'x',
            description: 'y',
            priority: 'normal',
            photoR2Keys: [],
          },
          TENANT_ID,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockMaintenanceCreate).not.toHaveBeenCalled();
    });

    it('rejects photoR2Keys with the wrong tenant prefix (cross-tenant tamper)', async () => {
      mockContractFindFirst.mockResolvedValueOnce({ id: 'ctr-1', unitId: UNIT_ID });

      await expect(
        service.createForTenant(
          {
            unitId: UNIT_ID,
            category: 'plumbing',
            title: 'x',
            description: 'y',
            priority: 'normal',
            photoR2Keys: [FOREIGN_PHOTO_KEY],
          },
          TENANT_ID,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(storage.headObject).not.toHaveBeenCalled();
      expect(mockMaintenanceCreate).not.toHaveBeenCalled();
    });

    it('rejects photoR2Keys whose R2 HEAD returns null (upload failed)', async () => {
      mockContractFindFirst.mockResolvedValueOnce({ id: 'ctr-1', unitId: UNIT_ID });
      storage.headObject.mockResolvedValueOnce(null);

      await expect(
        service.createForTenant(
          {
            unitId: UNIT_ID,
            category: 'plumbing',
            title: 'x',
            description: 'y',
            priority: 'normal',
            photoR2Keys: [VALID_PHOTO_KEY],
          },
          TENANT_ID,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockMaintenanceCreate).not.toHaveBeenCalled();
    });

    it('accepts an empty photoR2Keys array (text-only ticket allowed)', async () => {
      mockContractFindFirst.mockResolvedValueOnce({ id: 'ctr-1', unitId: UNIT_ID });
      mockMaintenanceCreate.mockResolvedValueOnce({ id: TICKET_ID });

      await service.createForTenant(
        {
          unitId: UNIT_ID,
          category: 'other',
          title: 'x',
          description: 'y',
          priority: 'normal',
          photoR2Keys: [],
        },
        TENANT_ID,
      );

      expect(storage.headObject).not.toHaveBeenCalled();
      expect(mockMaintenanceCreate).toHaveBeenCalledTimes(1);
    });
  });

  // =====================================================================
  // getByIdForTenant — cross-tenant probe
  // =====================================================================

  describe('getByIdForTenant', () => {
    it('queries with both id AND tenantId', async () => {
      const row = { id: TICKET_ID, tenantId: TENANT_ID };
      mockMaintenanceFindFirst.mockResolvedValueOnce(row);

      await expect(service.getByIdForTenant(TICKET_ID, TENANT_ID)).resolves.toBe(row);

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockMaintenanceFindFirst.mock.calls[0]![0];
      expect(args.where).toEqual({ id: TICKET_ID, tenantId: TENANT_ID });
    });

    it('throws NotFoundException when ticket belongs to another tenant', async () => {
      mockMaintenanceFindFirst.mockResolvedValueOnce(null);
      await expect(service.getByIdForTenant(TICKET_ID, TENANT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // =====================================================================
  // update — state machine + cross-field guards
  // =====================================================================

  describe('update — state machine', () => {
    it('open → in_progress is allowed', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce({ id: TICKET_ID, status: 'open' });
      mockMaintenanceUpdate.mockResolvedValueOnce({ id: TICKET_ID, status: 'in_progress' });

      await service.update(TICKET_ID, { status: 'in_progress' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockMaintenanceUpdate.mock.calls[0]![0];
      expect(args.data.status).toBe('in_progress');
      expect(args.data.resolvedAt).toBeUndefined();
    });

    it('in_progress → resolved sets resolvedAt + requires resolutionNote', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce({
        id: TICKET_ID,
        status: 'in_progress',
        resolutionNote: null,
      });
      mockMaintenanceUpdate.mockResolvedValueOnce({ id: TICKET_ID, status: 'resolved' });

      await service.update(TICKET_ID, {
        status: 'resolved',
        resolutionNote: 'แก้ก๊อกใหม่',
      });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockMaintenanceUpdate.mock.calls[0]![0];
      expect(args.data.status).toBe('resolved');
      expect(args.data.resolvedAt).toBeInstanceOf(Date);
    });

    it('refuses status=resolved when resolutionNote is missing', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce({
        id: TICKET_ID,
        status: 'in_progress',
        resolutionNote: null,
      });

      await expect(service.update(TICKET_ID, { status: 'resolved' })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockMaintenanceUpdate).not.toHaveBeenCalled();
    });

    it('refuses status=cancelled when resolutionNote is missing', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce({
        id: TICKET_ID,
        status: 'open',
        resolutionNote: null,
      });

      await expect(service.update(TICKET_ID, { status: 'cancelled' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('reopen (resolved → in_progress) clears resolvedAt', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce({
        id: TICKET_ID,
        status: 'resolved',
        resolutionNote: 'old note',
      });
      mockMaintenanceUpdate.mockResolvedValueOnce({ id: TICKET_ID });

      await service.update(TICKET_ID, { status: 'in_progress' });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockMaintenanceUpdate.mock.calls[0]![0];
      expect(args.data.status).toBe('in_progress');
      expect(args.data.resolvedAt).toBeNull();
    });

    it('refuses transition from closed (terminal)', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce({ id: TICKET_ID, status: 'closed' });

      await expect(service.update(TICKET_ID, { status: 'in_progress' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('refuses transition from cancelled (terminal)', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce({ id: TICKET_ID, status: 'cancelled' });

      await expect(service.update(TICKET_ID, { status: 'in_progress' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('refuses open → resolved (must go through in_progress)', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce({
        id: TICKET_ID,
        status: 'open',
        resolutionNote: 'whatever',
      });

      await expect(service.update(TICKET_ID, { status: 'resolved' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('idempotent same-status patch (open → open) is a no-op write', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce({ id: TICKET_ID, status: 'open' });
      mockMaintenanceUpdate.mockResolvedValueOnce({ id: TICKET_ID });

      await service.update(TICKET_ID, { status: 'open' });

      // No throw; just bumps updatedAt via the write.
      expect(mockMaintenanceUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('update — assignee', () => {
    it('verifies assignee user exists in this company before assigning', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce({ id: TICKET_ID, status: 'open' });
      mockUserFindUnique.mockResolvedValueOnce({ id: ASSIGNEE_USER_ID });
      mockMaintenanceUpdate.mockResolvedValueOnce({ id: TICKET_ID });

      await service.update(TICKET_ID, { assignedToUserId: ASSIGNEE_USER_ID });

      expect(mockUserFindUnique).toHaveBeenCalledWith({
        where: { id: ASSIGNEE_USER_ID },
        select: { id: true },
      });
      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockMaintenanceUpdate.mock.calls[0]![0];
      expect(args.data.assignedToUser).toEqual({ connect: { id: ASSIGNEE_USER_ID } });
    });

    it('rejects assignee that does not exist in this company', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce({ id: TICKET_ID, status: 'open' });
      mockUserFindUnique.mockResolvedValueOnce(null);

      await expect(
        service.update(TICKET_ID, { assignedToUserId: ASSIGNEE_USER_ID }),
      ).rejects.toThrow(BadRequestException);
      expect(mockMaintenanceUpdate).not.toHaveBeenCalled();
    });

    it('disconnect assignee when patch passes assignedToUserId=null', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce({ id: TICKET_ID, status: 'open' });
      mockMaintenanceUpdate.mockResolvedValueOnce({ id: TICKET_ID });

      await service.update(TICKET_ID, { assignedToUserId: null });

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = mockMaintenanceUpdate.mock.calls[0]![0];
      expect(args.data.assignedToUser).toEqual({ disconnect: true });
    });
  });

  // =====================================================================
  // Photo upload + view URL
  // =====================================================================

  describe('createPhotoUploadUrl', () => {
    it('mints a tenant-scoped key + presigned PUT URL', async () => {
      storage.generateUploadUrl.mockResolvedValueOnce({
        url: 'https://r2.example.com/signed',
        expiresAt: new Date('2026-04-30T00:00:00Z'),
      });

      const out = await service.createPhotoUploadUrl(
        { mimeType: 'image/jpeg', sizeBytes: 1234 },
        TENANT_ID,
      );

      // biome-ignore lint/style/noNonNullAssertion: call asserted by mockResolvedValueOnce
      const args = storage.generateUploadUrl.mock.calls[0]![0];
      expect(args.key).toMatch(
        new RegExp(`^companies/${COMPANY_ID}/maintenance/${TENANT_ID}/[0-9a-f-]+\\.jpg$`),
      );
      expect(args.contentType).toBe('image/jpeg');
      expect(args.contentLength).toBe(1234);
      expect(out.r2ObjectKey).toBe(args.key);
      expect(out.url).toBe('https://r2.example.com/signed');
      expect(out.expiresAt).toBe('2026-04-30T00:00:00.000Z');
    });
  });

  describe('getPhotoViewUrl', () => {
    it('mints a signed GET when key is in the ticket photoR2Keys array', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce({
        photoR2Keys: [VALID_PHOTO_KEY, 'companies/x/maintenance/y/other.jpg'],
      });
      storage.generateDownloadUrl.mockResolvedValueOnce({
        url: 'https://r2.example.com/get-signed',
        expiresAt: new Date('2026-04-30T00:00:00Z'),
      });

      const out = await service.getPhotoViewUrl(TICKET_ID, VALID_PHOTO_KEY);

      expect(storage.generateDownloadUrl).toHaveBeenCalledWith({ key: VALID_PHOTO_KEY });
      expect(out.url).toBe('https://r2.example.com/get-signed');
    });

    it('rejects a key that is NOT in the ticket photoR2Keys (cross-photo tamper)', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce({
        photoR2Keys: [VALID_PHOTO_KEY],
      });

      await expect(
        service.getPhotoViewUrl(TICKET_ID, 'companies/x/maintenance/y/foreign.jpg'),
      ).rejects.toThrow(BadRequestException);
      expect(storage.generateDownloadUrl).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when ticket id does not exist', async () => {
      mockMaintenanceFindUnique.mockResolvedValueOnce(null);

      await expect(service.getPhotoViewUrl(TICKET_ID, VALID_PHOTO_KEY)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
