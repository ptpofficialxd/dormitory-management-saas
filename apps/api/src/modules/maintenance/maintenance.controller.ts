import {
  type ListMaintenanceRequestsInput,
  type MaintenancePhotoViewUrlResponse,
  type MaintenanceRequest,
  type UpdateMaintenanceRequestInput,
  listMaintenanceRequestsInputSchema,
  updateMaintenanceRequestInputSchema,
} from '@dorm/shared/zod';
import { Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { Perm } from '../../common/decorators/perm.decorator.js';
import { ZodBody, ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { MaintenanceService } from './maintenance.service.js';

/**
 * Maintenance endpoints — `/c/:companySlug/maintenance` (admin path).
 *
 * RBAC (matrix-driven via @dorm/shared/rbac):
 *   - LIST / GET / GET photo view-url : `maintenance_ticket:read`
 *     (owner / property_manager / staff)
 *   - PATCH                            : `maintenance_ticket:update`
 *     (owner / property_manager / staff — staff can change status +
 *     resolution note; only manager+ should re-assign in practice but
 *     the matrix doesn't (yet) split that out)
 *
 * No POST here — tickets are tenant-created via `/me/maintenance`. Admin
 * "create-on-behalf-of-tenant" is out of scope for MVP (real-world ops
 * flow is "tenant calls front desk → front desk asks tenant to open LINE
 * + tap rich-menu maintenance button").
 *
 * No DELETE — tickets are append-only (audit trail). Use PATCH status →
 * cancelled to retire.
 *
 * Photo view URL is namespaced under `:id/photos/:key/view-url` rather
 * than a separate `photos/...` family because every photo lookup is
 * gated by ticket ownership — keeping it nested makes the
 * `getById → getPhotoViewUrl` call sequence obvious.
 */
@Controller('c/:companySlug/maintenance')
export class MaintenanceController {
  constructor(private readonly service: MaintenanceService) {}

  @Get()
  @Perm('read', 'maintenance_ticket')
  list(
    @ZodQuery(listMaintenanceRequestsInputSchema) query: ListMaintenanceRequestsInput,
  ): Promise<CursorPage<MaintenanceRequest>> {
    return this.service.list(query);
  }

  @Get(':id')
  @Perm('read', 'maintenance_ticket')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<MaintenanceRequest> {
    return this.service.getById(id);
  }

  @Patch(':id')
  @Perm('update', 'maintenance_ticket')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ZodBody(updateMaintenanceRequestInputSchema) body: UpdateMaintenanceRequestInput,
  ): Promise<MaintenanceRequest> {
    return this.service.update(id, body);
  }

  /**
   * Mint a short-lived signed GET URL for a tenant-uploaded photo. The
   * service revalidates that `key` belongs to the ticket — preventing a
   * caller with `read` perm from minting URLs for arbitrary R2 keys by
   * supplying a ticket id they can see + a foreign key.
   *
   * `key` is URL-encoded by the client (it contains `/` chars). Express /
   * Fastify decode automatically; the inner slashes inside the R2 key
   * (e.g. `companies/.../maintenance/.../uuid.jpg`) survive intact.
   */
  @Get(':id/photos/:key/view-url')
  @Perm('read', 'maintenance_ticket')
  getPhotoViewUrl(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('key') key: string,
  ): Promise<MaintenancePhotoViewUrlResponse> {
    return this.service.getPhotoViewUrl(id, key);
  }
}
