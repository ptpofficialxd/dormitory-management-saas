import {
  type Contract,
  type CreateContractInput,
  type ListContractsQuery,
  type UpdateContractInput,
  createContractInputSchema,
  listContractsQuerySchema,
  updateContractInputSchema,
} from '@dorm/shared/zod';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ZodBody, ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { ContractService } from './contract.service.js';

/**
 * Contract endpoints — `/c/:companySlug/contracts`.
 *
 * RBAC:
 *   - LIST / GET     : any authenticated admin role
 *   - POST / PATCH   : `company_owner`, `property_manager` — staff don't sign
 *     contracts (legal commitment); they handle day-to-day tenant ops only.
 *
 * No DELETE — Contract cascades into Invoice/Payment. Use
 * `PATCH { status: "terminated" }` for early break or `"ended"` for natural
 * expiry. The row stays for billing audit.
 */
@Controller('c/:companySlug/contracts')
export class ContractController {
  constructor(private readonly contractService: ContractService) {}

  @Get()
  list(
    @ZodQuery(listContractsQuerySchema) query: ListContractsQuery,
  ): Promise<CursorPage<Contract>> {
    return this.contractService.list(query);
  }

  @Get(':id')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<Contract> {
    return this.contractService.getById(id);
  }

  @Post()
  @HttpCode(201)
  @Roles('company_owner', 'property_manager')
  create(@ZodBody(createContractInputSchema) body: CreateContractInput): Promise<Contract> {
    return this.contractService.create(body);
  }

  @Patch(':id')
  @Roles('company_owner', 'property_manager')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ZodBody(updateContractInputSchema) body: UpdateContractInput,
  ): Promise<Contract> {
    return this.contractService.update(id, body);
  }
}
