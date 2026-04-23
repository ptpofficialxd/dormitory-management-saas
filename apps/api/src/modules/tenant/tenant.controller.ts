import {
  type CreateTenantInput,
  type ListTenantsQuery,
  type Tenant,
  type UpdateTenantInput,
  createTenantInputSchema,
  listTenantsQuerySchema,
  updateTenantInputSchema,
} from '@dorm/shared/zod';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Perm } from '../../common/decorators/perm.decorator.js';
import { ZodBody, ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { TenantService } from './tenant.service.js';

/**
 * Tenant endpoints — `/c/:companySlug/tenants`.
 *
 * RBAC:
 *   - LIST / GET     : any authenticated admin role
 *   - POST / PATCH   : `company_owner`, `property_manager`, `staff` — staff
 *     are the day-to-day onboarding hands so they get write access.
 *
 * No DELETE — `Tenant` cascades into Contract / Invoice / Payment. Use
 * `PATCH { status: "moved_out" }` to retire a tenant; the row stays for audit.
 */
@Controller('c/:companySlug/tenants')
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Get()
  list(@ZodQuery(listTenantsQuerySchema) query: ListTenantsQuery): Promise<CursorPage<Tenant>> {
    return this.tenantService.list(query);
  }

  @Get(':id')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<Tenant> {
    return this.tenantService.getById(id);
  }

  @Post()
  @HttpCode(201)
  @Perm('create', 'tenant_user')
  create(@ZodBody(createTenantInputSchema) body: CreateTenantInput): Promise<Tenant> {
    return this.tenantService.create(body);
  }

  @Patch(':id')
  @Perm('update', 'tenant_user')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ZodBody(updateTenantInputSchema) body: UpdateTenantInput,
  ): Promise<Tenant> {
    return this.tenantService.update(id, body);
  }
}
