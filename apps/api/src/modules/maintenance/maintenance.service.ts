import { randomUUID } from 'node:crypto';
import { type Prisma, getTenantContext, prisma } from '@dorm/db';
import type {
  CreateMaintenanceRequestInput,
  ListMaintenanceRequestsInput,
  MaintenancePhotoMimeType,
  MaintenancePhotoUploadUrlInput,
  MaintenancePhotoUploadUrlResponse,
  MaintenancePhotoViewUrlResponse,
  MaintenanceRequest,
  TenantUpdateMaintenanceRequestInput,
  UpdateMaintenanceRequestInput,
} from '@dorm/shared/zod';
import { MAINTENANCE_PHOTO_MAX } from '@dorm/shared/zod';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { type CursorPage, buildCursorPage, decodeCursor } from '../../common/util/cursor.util.js';
import { StorageService } from '../storage/storage.service.js';

/**
 * MaintenanceService — tenant-reported repair tickets (Sprint B / Task #88).
 *
 * Two caller paths:
 *   - Admin (`/c/:slug/maintenance`): list/get/update; assign + status flips
 *   - Tenant (`/me/maintenance`): own list/get/create + photo upload-url
 *
 * State machine (enforced server-side, NOT in DB):
 *
 *   open ──► in_progress ──► resolved ──► closed
 *      │          │              │
 *      └──────────┴──────────────┴──► cancelled (terminal from any non-closed)
 *
 *   Re-open: resolved → in_progress (clears `resolvedAt`)
 *   Terminal: closed, cancelled (no transitions out)
 *
 * Cross-field invariants (enforced here):
 *   - status → resolved   requires resolutionNote
 *   - status → cancelled  requires resolutionNote (tenant sees the reason)
 *   - assignedToUserId is INDEPENDENT of status — admin sets explicitly
 *   - assignedToUserId must reference a User in the same company (RLS guard)
 *
 * Cross-tenant guards:
 *   - LIFF caller can only see/mutate own tickets — service narrows by
 *     tenantId from JWT (controllers force this; service re-pins as defence
 *     in depth). Cross-tenant probes get 404 (NEVER 403 — no leak).
 *
 * Photos:
 *   - Stored in R2 private bucket as `companies/{companyId}/maintenance/
 *     {tenantId}/{uuid}.{ext}`.
 *   - Tenant calls `createPhotoUploadUrl` (1 photo at a time), gets a key,
 *     PUTs raw bytes to R2 directly, repeats for N photos.
 *   - At ticket create, server validates each key has the tenant's prefix
 *     + R2 HEAD confirms it exists.
 *   - Admin views via `getPhotoViewUrl` — short-lived signed GET (≤ 5 min).
 *
 * No DELETE — tickets are append-only. Use `cancelled` to retire.
 */
@Injectable()
export class MaintenanceService {
  constructor(private readonly storage: StorageService) {}

  // ---------------------------------------------------------------
  // Read paths
  // ---------------------------------------------------------------

  /**
   * Cursor-paginated list with all the filters from
   * `listMaintenanceRequestsInputSchema`. RLS scopes by company; the optional
   * tenantId / unit / status / assignee / category / priority / date range
   * filters AND together.
   */
  async list(query: ListMaintenanceRequestsInput): Promise<CursorPage<MaintenanceRequest>> {
    const { cursor, limit, status, priority, category, unitId, tenantId, assignedToUserId } = query;
    const decoded = cursor ? decodeCursor(cursor) : null;

    const baseWhere: Prisma.MaintenanceRequestWhereInput = {};
    if (status) baseWhere.status = status;
    if (priority) baseWhere.priority = priority;
    if (category) baseWhere.category = category;
    if (unitId) baseWhere.unitId = unitId;
    if (tenantId) baseWhere.tenantId = tenantId;
    if (assignedToUserId) baseWhere.assignedToUserId = assignedToUserId;
    if (query.fromDate || query.toDate) {
      baseWhere.createdAt = {
        ...(query.fromDate ? { gte: new Date(query.fromDate) } : {}),
        ...(query.toDate ? { lt: new Date(query.toDate) } : {}),
      };
    }

    const where: Prisma.MaintenanceRequestWhereInput = decoded
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

    const rows = await prisma.maintenanceRequest.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return buildCursorPage(rows as unknown as MaintenanceRequest[], limit);
  }

  /**
   * Tenant-scoped list — `tenantId` is forced from JWT at the controller
   * boundary. We re-pin here so a future direct-service caller can't cheat.
   */
  async listForTenant(
    query: ListMaintenanceRequestsInput,
    tenantId: string,
  ): Promise<CursorPage<MaintenanceRequest>> {
    return this.list({ ...query, tenantId });
  }

  async getById(id: string): Promise<MaintenanceRequest> {
    const row = await prisma.maintenanceRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Maintenance request ${id} not found`);
    return row as unknown as MaintenanceRequest;
  }

  /**
   * Tenant-scoped getById — `tenantId` enforced via WHERE so a cross-tenant
   * probe gets 404 (NEVER 403; no leak of "this id is real but not yours").
   */
  async getByIdForTenant(id: string, tenantId: string): Promise<MaintenanceRequest> {
    const row = await prisma.maintenanceRequest.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException(`Maintenance request ${id} not found`);
    return row as unknown as MaintenanceRequest;
  }

  // ---------------------------------------------------------------
  // Write paths — tenant create
  // ---------------------------------------------------------------

  /**
   * Tenant creates a ticket via LIFF. Auto-derives `unitId` from the
   * tenant's active contract (caller may also pass an explicit unitId, but
   * we override with the contract-side value to prevent a tenant submitting
   * tickets against another unit they happened to learn the id of).
   *
   * Photo validation:
   *   - Each `photoR2Keys[i]` MUST start with `companies/{companyId}/
   *     maintenance/{tenantId}/` — the prefix the upload-url endpoint
   *     mints. A tampered key targeting another tenant's namespace gets 400.
   *   - Each key R2-HEADs to confirm the bytes actually landed (mirrors
   *     SlipService.register). Missing object → 400.
   *
   * Returns the freshly-created ticket. No idempotency — POST is tenant-
   * initiated single-shot; if it succeeds twice the duplicate ticket can
   * be cancelled by admin.
   */
  async createForTenant(
    input: CreateMaintenanceRequestInput,
    tenantId: string,
  ): Promise<MaintenanceRequest> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on maintenance create');
    }

    // Find active contract — derive the canonical unitId. The tenant can
    // technically have multiple contracts (move between units) but only
    // one ACTIVE at a time per business rule. If none → tenant can't file
    // a maintenance request (no unit to attribute it to).
    const activeContract = await prisma.contract.findFirst({
      where: { tenantId, status: 'active' },
      select: { id: true, unitId: true },
      orderBy: { startDate: 'desc' },
    });
    if (!activeContract) {
      throw new BadRequestException({
        error: 'NoActiveContract',
        message: 'You must have an active rental contract before reporting maintenance issues',
      });
    }

    // Override caller-supplied unitId — defends against a tenant guessing
    // a sibling's unit id and filing tickets there.
    const unitId = activeContract.unitId;

    // Photo prefix + HEAD validation.
    const expectedPrefix = `companies/${ctx.companyId}/maintenance/${tenantId}/`;
    for (const key of input.photoR2Keys) {
      if (!key.startsWith(expectedPrefix)) {
        throw new BadRequestException({
          error: 'InvalidPhotoR2Key',
          message: `Photo key does not match the expected prefix for this tenant: ${key}`,
        });
      }
      const head = await this.storage.headObject(key);
      if (!head) {
        throw new BadRequestException({
          error: 'PhotoNotUploaded',
          message: `No R2 object found at ${key} — upload may have failed`,
        });
      }
    }

    const row = await prisma.maintenanceRequest.create({
      data: {
        companyId: ctx.companyId,
        unitId,
        tenantId,
        category: input.category,
        title: input.title,
        description: input.description,
        priority: input.priority ?? 'normal',
        status: 'open',
        photoR2Keys: input.photoR2Keys,
      },
    });
    return row as unknown as MaintenanceRequest;
  }

  // ---------------------------------------------------------------
  // Write paths — admin update (state machine)
  // ---------------------------------------------------------------

  /**
   * Admin update — handles status transitions, priority changes,
   * assignment, and resolution notes. All fields optional; service refuses
   * an empty patch at the Zod boundary (`refine` in
   * `updateMaintenanceRequestInputSchema`).
   *
   * State-machine guards:
   *   - open      → in_progress | cancelled
   *   - in_progress → resolved | cancelled
   *   - resolved  → in_progress (re-open, clears resolvedAt) | closed | cancelled
   *   - closed    → no transitions (terminal)
   *   - cancelled → no transitions (terminal)
   *
   * Cross-field rules:
   *   - status=resolved requires `resolutionNote` (tenant sees this)
   *   - status=cancelled requires `resolutionNote` (tenant sees the reason)
   *   - reopening (resolved → in_progress) clears `resolvedAt`
   *
   * Assignee guard:
   *   - `assignedToUserId` (when non-null) must reference a User in the
   *     same company — same RLS scope. Cross-company assignment is blocked
   *     by a pre-INSERT lookup (RLS would 0-row the FK target but allow the
   *     UPDATE through, leaving an orphan).
   */
  async update(id: string, input: UpdateMaintenanceRequestInput): Promise<MaintenanceRequest> {
    const existing = await this.getById(id);

    // Build the data patch incrementally as we validate each field.
    const data: Prisma.MaintenanceRequestUpdateInput = {};

    // ---- assignee ---------------------------------------------------
    if (input.assignedToUserId !== undefined) {
      if (input.assignedToUserId !== null) {
        const user = await prisma.user.findUnique({
          where: { id: input.assignedToUserId },
          select: { id: true },
        });
        if (!user) {
          throw new BadRequestException({
            error: 'InvalidAssignee',
            message: `User ${input.assignedToUserId} does not exist or is not in this company`,
          });
        }
      }
      data.assignedToUser =
        input.assignedToUserId === null
          ? { disconnect: true }
          : { connect: { id: input.assignedToUserId } };
    }

    // ---- priority ---------------------------------------------------
    if (input.priority !== undefined) {
      data.priority = input.priority;
    }

    // ---- status (state machine) -------------------------------------
    if (input.status !== undefined) {
      assertStatusTransition(existing.status, input.status);

      if (input.status === 'resolved' || input.status === 'cancelled') {
        // Need a resolutionNote — either patched in this call, or already
        // present on the row. If neither, refuse — tenant-facing UX
        // requires a reason.
        const noteOnRow = existing.resolutionNote;
        const noteInPatch = input.resolutionNote;
        const finalNote = noteInPatch !== undefined ? noteInPatch : noteOnRow;
        if (!finalNote || finalNote.trim().length === 0) {
          throw new BadRequestException({
            error: 'ResolutionNoteRequired',
            message: `Cannot move ticket to "${input.status}" without a resolutionNote — tenant needs to know why`,
          });
        }
      }

      data.status = input.status;

      if (input.status === 'resolved') {
        data.resolvedAt = new Date();
      } else if (existing.status === 'resolved') {
        // Reopening: resolved → anything-but-resolved → clear resolvedAt
        // so the audit trail doesn't keep stale "resolved at X" data.
        data.resolvedAt = null;
      }
    }

    // ---- resolutionNote (standalone, e.g. amendment) ---------------
    if (input.resolutionNote !== undefined) {
      data.resolutionNote = input.resolutionNote;
    }

    const row = await prisma.maintenanceRequest.update({
      where: { id },
      data,
    });
    return row as unknown as MaintenanceRequest;
  }

  // ---------------------------------------------------------------
  // Write paths — tenant self-update (Sprint B / Task #100)
  // ---------------------------------------------------------------

  /**
   * Tenant self-update via LIFF — narrow surface area vs admin `update`:
   *   - `cancel: true`         → status open ONLY (terminal cancel; admin
   *                              cancellation flow is unaffected)
   *   - `description`          → status in [open, in_progress] (after that,
   *                              ticket is staff-owned + immutable to tenant)
   *   - `appendPhotoR2Keys[]`  → status in [open, in_progress]; APPEND only,
   *                              never replace; combined cap MAINTENANCE_PHOTO_MAX
   *
   * Defence-in-depth (mirrors `getByIdForTenant`):
   *   - `tenantId` enforced via WHERE — cross-tenant probes 404 before any
   *     state machine check (NEVER 403; no leak of "this id is real").
   *   - Photo prefix re-validated for every appended key (a tampered key
   *     targeting another tenant's namespace gets 400).
   *   - R2 HEAD on every appended key (mirrors createForTenant) — silent
   *     drops at the CDN edge surface as 400, not as a corrupt ticket row.
   *
   * Resolution-note semantics: tenant cancellation auto-fills
   * `resolutionNote` with a fixed sentinel ("ผู้เช่ายกเลิกเอง") because:
   *   1. The schema requires a non-empty resolutionNote on cancel (admin
   *      contract — see `update` cross-field rule).
   *   2. Tenant UI doesn't ask for a free-form reason (one less form field
   *      at the cancel-dialog moment); admin can read the sentinel + ticket
   *      timeline to infer intent if needed.
   */
  async updateForTenant(
    id: string,
    input: TenantUpdateMaintenanceRequestInput,
    tenantId: string,
  ): Promise<MaintenanceRequest> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on maintenance update');
    }

    const existing = await this.getByIdForTenant(id, tenantId);

    // Build patch incrementally so per-field validation runs independently +
    // each error message names the failing field.
    const data: Prisma.MaintenanceRequestUpdateInput = {};

    // ---- cancel ---------------------------------------------------------
    if (input.cancel === true) {
      // Tenant-initiated cancel only valid when ticket is still in `open`.
      // Once staff picks it up (in_progress) → tenant must contact staff
      // directly; staff handles cancel via admin endpoint.
      if (existing.status !== 'open') {
        throw new ConflictException({
          error: 'TenantCancelNotAllowed',
          message: `You can only cancel tickets in "open" status (current: "${existing.status}"). Contact staff to cancel an in-progress ticket.`,
        });
      }
      data.status = 'cancelled';
      // Sentinel reason — surfaces to admin / future timeline view.
      data.resolutionNote = 'ผู้เช่ายกเลิกเอง';
    }

    // ---- description ----------------------------------------------------
    if (input.description !== undefined) {
      if (existing.status !== 'open' && existing.status !== 'in_progress') {
        throw new ConflictException({
          error: 'TenantEditNotAllowed',
          message: `Cannot edit ticket in "${existing.status}" status — tenant edits are limited to open / in_progress tickets.`,
        });
      }
      // Cancel + edit-description in the same call would be contradictory
      // (we just set status=cancelled above). Reject to keep semantics clean.
      if (input.cancel === true) {
        throw new BadRequestException({
          error: 'CancelAndEditConflict',
          message: 'Cannot cancel and edit description in the same request',
        });
      }
      data.description = input.description;
    }

    // ---- appendPhotoR2Keys ----------------------------------------------
    if (input.appendPhotoR2Keys !== undefined && input.appendPhotoR2Keys.length > 0) {
      if (existing.status !== 'open' && existing.status !== 'in_progress') {
        throw new ConflictException({
          error: 'TenantEditNotAllowed',
          message: `Cannot add photos to ticket in "${existing.status}" status — tenant edits are limited to open / in_progress tickets.`,
        });
      }
      if (input.cancel === true) {
        throw new BadRequestException({
          error: 'CancelAndEditConflict',
          message: 'Cannot cancel and append photos in the same request',
        });
      }

      // Combined cap — schema-level cap is per-array; we enforce the
      // existing+appended total here (cross-field rule).
      const combined = existing.photoR2Keys.length + input.appendPhotoR2Keys.length;
      if (combined > MAINTENANCE_PHOTO_MAX) {
        throw new BadRequestException({
          error: 'TooManyPhotos',
          message: `Total photos would be ${combined} — cap is ${MAINTENANCE_PHOTO_MAX}. Existing: ${existing.photoR2Keys.length}, attempting to add: ${input.appendPhotoR2Keys.length}.`,
        });
      }

      // Same prefix + HEAD validation as createForTenant — defence in depth
      // against a tampered echo from the client supplying a key from
      // another tenant's namespace or a never-uploaded key.
      const expectedPrefix = `companies/${ctx.companyId}/maintenance/${tenantId}/`;
      for (const key of input.appendPhotoR2Keys) {
        if (!key.startsWith(expectedPrefix)) {
          throw new BadRequestException({
            error: 'InvalidPhotoR2Key',
            message: `Photo key does not match the expected prefix for this tenant: ${key}`,
          });
        }
        const head = await this.storage.headObject(key);
        if (!head) {
          throw new BadRequestException({
            error: 'PhotoNotUploaded',
            message: `No R2 object found at ${key} — upload may have failed`,
          });
        }
      }

      // Append (not replace) — preserves the original chronological order
      // of the report and lets admin see "tenant added 2 more photos
      // 3h after filing" via createdAt vs updatedAt deltas.
      data.photoR2Keys = [...existing.photoR2Keys, ...input.appendPhotoR2Keys];
    }

    const row = await prisma.maintenanceRequest.update({
      where: { id },
      data,
    });
    return row as unknown as MaintenanceRequest;
  }

  // ---------------------------------------------------------------
  // Photo upload + view URL
  // ---------------------------------------------------------------

  /**
   * Mint a presigned PUT URL for a single maintenance photo. Tenants call
   * this once per photo BEFORE submitting the ticket — collect N keys, then
   * pass `photoR2Keys: [keys...]` in the create payload.
   *
   * Key format: `companies/{companyId}/maintenance/{tenantId}/{uuid}.{ext}`
   * — tenantId-scoped (NOT ticketId) because the ticket doesn't exist yet.
   */
  async createPhotoUploadUrl(
    input: MaintenancePhotoUploadUrlInput,
    tenantId: string,
  ): Promise<MaintenancePhotoUploadUrlResponse> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on photo upload-url');
    }

    const r2ObjectKey = buildPhotoKey({
      companyId: ctx.companyId,
      tenantId,
      mimeType: input.mimeType,
    });

    const signed = await this.storage.generateUploadUrl({
      key: r2ObjectKey,
      contentType: input.mimeType,
      contentLength: input.sizeBytes,
    });

    return {
      url: signed.url,
      r2ObjectKey,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  /**
   * Mint a short-lived GET URL for previewing a tenant-uploaded photo.
   * Both admin (admin photo viewer) and tenant (own ticket detail) can call
   * this — caller is responsible for the ownership pre-check via
   * `getById` / `getByIdForTenant`.
   *
   * `photoKey` MUST be a member of the ticket's `photoR2Keys` array — we
   * re-validate to prevent a caller from minting a signed URL for an
   * arbitrary R2 key by supplying a ticket id they CAN see + a foreign key
   * they guessed.
   */
  async getPhotoViewUrl(
    ticketId: string,
    photoKey: string,
  ): Promise<MaintenancePhotoViewUrlResponse> {
    const ticket = await prisma.maintenanceRequest.findUnique({
      where: { id: ticketId },
      select: { photoR2Keys: true },
    });
    if (!ticket) {
      throw new NotFoundException(`Maintenance request ${ticketId} not found`);
    }
    if (!ticket.photoR2Keys.includes(photoKey)) {
      throw new BadRequestException({
        error: 'PhotoNotInTicket',
        message: 'photoKey does not belong to this ticket',
      });
    }
    const signed = await this.storage.generateDownloadUrl({ key: photoKey });
    return {
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }
}

// ---------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------

/**
 * Allowed status transitions. Anything not listed here gets a 409.
 * Same shape as the Invoice / Payment state-machine helpers — keeps the
 * "what's allowed" logic in one place per service.
 */
const STATUS_TRANSITIONS: Record<
  MaintenanceRequest['status'],
  readonly MaintenanceRequest['status'][]
> = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['resolved', 'cancelled'],
  // Reopen + close + cancel — admin discretion.
  resolved: ['in_progress', 'closed', 'cancelled'],
  // Terminal — no transitions out.
  closed: [],
  cancelled: [],
};

function assertStatusTransition(
  from: MaintenanceRequest['status'],
  to: MaintenanceRequest['status'],
): void {
  // No-op (idempotent re-set) — accept silently. The DB write will still
  // bump updatedAt; that's fine.
  if (from === to) return;
  const allowed = STATUS_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new ConflictException({
      error: 'InvalidStatusTransition',
      message: `Cannot transition from "${from}" to "${to}" — allowed: ${allowed.length === 0 ? '(terminal)' : allowed.join(', ')}`,
    });
  }
}

/**
 * Map MIME → file extension for the R2 key. Mirrors slip.service's helper —
 * kept local instead of shared because the allowlist diverges (no PDF here).
 */
function extensionForMimeType(mime: MaintenancePhotoMimeType): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
  }
}

function buildPhotoKey(args: {
  companyId: string;
  tenantId: string;
  mimeType: MaintenancePhotoMimeType;
}): string {
  const ext = extensionForMimeType(args.mimeType);
  return `companies/${args.companyId}/maintenance/${args.tenantId}/${randomUUID()}.${ext}`;
}
