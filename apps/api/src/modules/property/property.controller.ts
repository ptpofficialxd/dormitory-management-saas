import {
  type CreatePropertyInput,
  type ListPropertiesQuery,
  type Property,
  type UpdatePropertyInput,
  createPropertyInputSchema,
  listPropertiesQuerySchema,
  updatePropertyInputSchema,
} from '@dorm/shared/zod';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ZodBody, ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { PropertyService } from './property.service.js';

/**
 * Property endpoints — `/c/:companySlug/properties`. The global
 * `PathCompanyGuard` already asserts URL `:companySlug` matches the JWT's
 * `companySlug` so we don't re-check here.
 *
 * RBAC:
 *   - LIST / GET     : any authenticated admin (no `@Roles` → all roles pass)
 *   - POST / PATCH   : `company_owner` or `property_manager` only
 *
 * Delete is intentionally absent in MVP — see PropertyService comment for why.
 */
@Controller('c/:companySlug/properties')
export class PropertyController {
  constructor(private readonly propertyService: PropertyService) {}

  @Get()
  list(
    @ZodQuery(listPropertiesQuerySchema) query: ListPropertiesQuery,
  ): Promise<CursorPage<Property>> {
    return this.propertyService.list(query);
  }

  @Get(':id')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<Property> {
    return this.propertyService.getById(id);
  }

  @Post()
  @HttpCode(201)
  @Roles('company_owner', 'property_manager')
  create(@ZodBody(createPropertyInputSchema) body: CreatePropertyInput): Promise<Property> {
    return this.propertyService.create(body);
  }

  @Patch(':id')
  @Roles('company_owner', 'property_manager')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ZodBody(updatePropertyInputSchema) body: UpdatePropertyInput,
  ): Promise<Property> {
    return this.propertyService.update(id, body);
  }
}
