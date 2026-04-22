import {
  type BatchGenerateInvoicesInput,
  type BatchGenerateInvoicesResult,
  type CreateInvoiceInput,
  type Invoice,
  type IssueInvoiceInput,
  type ListInvoicesQuery,
  type UpdateInvoiceInput,
  type VoidInvoiceInput,
  batchGenerateInvoicesInputSchema,
  createInvoiceInputSchema,
  issueInvoiceInputSchema,
  listInvoicesQuerySchema,
  updateInvoiceInputSchema,
  voidInvoiceInputSchema,
} from '@dorm/shared/zod';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ZodBody, ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { InvoiceService } from './invoice.service.js';

/**
 * Invoice endpoints — `/c/:companySlug/invoices`.
 *
 * RBAC:
 *   - LIST / GET     : any authenticated admin role (LIFF tenant view comes
 *     in Phase 2 via a separate `/me/invoices` controller — keeps RBAC
 *     surface small here).
 *   - POST / PATCH   : `company_owner`, `property_manager` — staff don't
 *     create invoices in MVP (they capture readings; manager generates the
 *     batch and reviews before issuing).
 *   - POST /batch    : `company_owner`, `property_manager` — same reasoning.
 *   - POST /:id/issue: `company_owner`, `property_manager`.
 *   - POST /:id/void : `company_owner`, `property_manager` — voiding affects
 *     reconciliation; restricted to manager+.
 *
 * No DELETE — invoices are append-only by design (audit trail). Use
 * POST /:id/void to nullify a draft/issued invoice; the row stays for history.
 *
 * Status transitions go through dedicated endpoints (not generic PATCH) so the
 * state-machine isn't sidestepped. PATCH is restricted to `dueDate`.
 */
@Controller('c/:companySlug/invoices')
export class InvoiceController {
  constructor(private readonly invoiceService: InvoiceService) {}

  @Get()
  list(@ZodQuery(listInvoicesQuerySchema) query: ListInvoicesQuery): Promise<CursorPage<Invoice>> {
    return this.invoiceService.list(query);
  }

  @Get(':id')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<Invoice> {
    return this.invoiceService.getById(id);
  }

  @Post()
  @HttpCode(201)
  @Roles('company_owner', 'property_manager')
  create(@ZodBody(createInvoiceInputSchema) body: CreateInvoiceInput): Promise<Invoice> {
    return this.invoiceService.create(body);
  }

  /**
   * Batch generation — manager-triggered "create draft invoices for period XYZ".
   * Returns the list of generated IDs + a per-unit skip list (with reason)
   * so the manager UI can render "Fix these and re-run".
   *
   * 200 (not 201) because the response is a result envelope, not a single
   * created resource. Multiple resources may have been created — caller
   * inspects `generatedInvoiceIds`.
   */
  @Post('batch')
  @HttpCode(200)
  @Roles('company_owner', 'property_manager')
  createBatch(
    @ZodBody(batchGenerateInvoicesInputSchema) body: BatchGenerateInvoicesInput,
  ): Promise<BatchGenerateInvoicesResult> {
    return this.invoiceService.createBatch(body);
  }

  @Patch(':id')
  @Roles('company_owner', 'property_manager')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ZodBody(updateInvoiceInputSchema) body: UpdateInvoiceInput,
  ): Promise<Invoice> {
    return this.invoiceService.update(id, body);
  }

  /**
   * Issue a draft invoice — generates PromptPay payload + flips status to
   * `issued`. Empty body (the strict `{}` schema rejects unknown fields so
   * a typo'd `{"force": true}` doesn't silently slip through).
   */
  @Post(':id/issue')
  @HttpCode(200)
  @Roles('company_owner', 'property_manager')
  issue(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ZodBody(issueInvoiceInputSchema) _body: IssueInvoiceInput,
  ): Promise<Invoice> {
    return this.invoiceService.issue(id);
  }

  /**
   * Void an invoice — requires a human-readable reason. The reason is
   * captured by the AuditLogInterceptor (no on-Invoice column).
   */
  @Post(':id/void')
  @HttpCode(200)
  @Roles('company_owner', 'property_manager')
  void(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ZodBody(voidInvoiceInputSchema) body: VoidInvoiceInput,
  ): Promise<Invoice> {
    return this.invoiceService.void(id, body.reason);
  }
}
