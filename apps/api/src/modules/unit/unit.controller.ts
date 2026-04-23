import {
  type CreateUnitInput,
  type ListUnitsQuery,
  type Unit,
  type UpdateUnitInput,
  createUnitInputSchema,
  listUnitsQuerySchema,
  updateUnitInputSchema,
} from '@dorm/shared/zod';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Perm } from '../../common/decorators/perm.decorator.js';
import { ZodBody, ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { UnitService } from './unit.service.js';

/**
 * Unit endpoints — `/c/:companySlug/units`.
 *
 * RBAC:
 *   - LIST / GET     : any authenticated admin
 *   - POST / PATCH   : `company_owner` or `property_manager`
 *
 * No DELETE — Unit cascades into Contract / Meter / Reading / Invoice; safer
 * to flip `status = maintenance` for retired rooms (handled by PATCH).
 */
@Controller('c/:companySlug/units')
export class UnitController {
  constructor(private readonly unitService: UnitService) {}

  @Get()
  list(@ZodQuery(listUnitsQuerySchema) query: ListUnitsQuery): Promise<CursorPage<Unit>> {
    return this.unitService.list(query);
  }

  @Get(':id')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<Unit> {
    return this.unitService.getById(id);
  }

  @Post()
  @HttpCode(201)
  @Perm('create', 'unit')
  create(@ZodBody(createUnitInputSchema) body: CreateUnitInput): Promise<Unit> {
    return this.unitService.create(body);
  }

  @Patch(':id')
  @Perm('update', 'unit')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ZodBody(updateUnitInputSchema) body: UpdateUnitInput,
  ): Promise<Unit> {
    return this.unitService.update(id, body);
  }
}
