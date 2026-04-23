import {
  type CreateMeterInput,
  type ListMetersQuery,
  type Meter,
  type UpdateMeterInput,
  createMeterInputSchema,
  listMetersQuerySchema,
  updateMeterInputSchema,
} from '@dorm/shared/zod';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Perm } from '../../common/decorators/perm.decorator.js';
import { ZodBody, ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { MeterService } from './meter.service.js';

/**
 * Meter endpoints — `/c/:companySlug/meters`.
 *
 * RBAC:
 *   - LIST / GET     : any authenticated admin role
 *   - POST / PATCH   : `company_owner`, `property_manager`, `staff` — staff
 *     install meters and update tariffs as part of routine ops.
 *
 * No DELETE — Meter cascades into Reading. Phase-2 will introduce a "retired"
 * status to hide old meters from the reading workflow without losing history.
 */
@Controller('c/:companySlug/meters')
export class MeterController {
  constructor(private readonly meterService: MeterService) {}

  @Get()
  list(@ZodQuery(listMetersQuerySchema) query: ListMetersQuery): Promise<CursorPage<Meter>> {
    return this.meterService.list(query);
  }

  @Get(':id')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<Meter> {
    return this.meterService.getById(id);
  }

  @Post()
  @HttpCode(201)
  @Perm('create', 'meter')
  create(@ZodBody(createMeterInputSchema) body: CreateMeterInput): Promise<Meter> {
    return this.meterService.create(body);
  }

  @Patch(':id')
  @Perm('update', 'meter')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ZodBody(updateMeterInputSchema) body: UpdateMeterInput,
  ): Promise<Meter> {
    return this.meterService.update(id, body);
  }
}
