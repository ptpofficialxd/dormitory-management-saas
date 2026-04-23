import {
  type ConfirmPaymentInput,
  type CreatePaymentInput,
  type ListPaymentsQuery,
  type Payment,
  type RejectPaymentInput,
  confirmPaymentInputSchema,
  createPaymentInputSchema,
  listPaymentsQuerySchema,
  rejectPaymentInputSchema,
} from '@dorm/shared/zod';
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Perm } from '../../common/decorators/perm.decorator.js';
import { ZodBody, ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { PaymentService } from './payment.service.js';

/**
 * Payment endpoints — `/c/:companySlug/payments`.
 *
 * RBAC:
 *   - LIST / GET             : any authenticated admin role
 *   - POST                   : `company_owner`, `property_manager`, `staff`
 *     — staff records cash payments at the front desk; managers approve
 *     promptpay/bank slips. (LIFF tenant-initiated POST comes in Phase 2 via
 *     a separate `/me/payments` controller — keeps RBAC surface small here.)
 *   - POST /:id/confirm      : `company_owner`, `property_manager` — financial
 *     decisions are restricted to manager+; staff can record but not approve.
 *   - POST /:id/reject       : `company_owner`, `property_manager` — same.
 *
 * No PATCH / DELETE — payments are append-only by design (audit trail). Use
 * confirm/reject to finalise; create a new payment + reject the old one to
 * "edit" an unconfirmed entry.
 *
 * Idempotency-Key: REQUIRED on POST. The header is read inline (no decorator
 * yet — we don't have a global idempotency interceptor in MVP) and rejected
 * with 400 if missing. Service maps DB-level uniqueness to a 200 with the
 * existing row.
 */
@Controller('c/:companySlug/payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Get()
  list(@ZodQuery(listPaymentsQuerySchema) query: ListPaymentsQuery): Promise<CursorPage<Payment>> {
    return this.paymentService.list(query);
  }

  @Get(':id')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<Payment> {
    return this.paymentService.getById(id);
  }

  /**
   * 201 on a fresh insert; 200 on idempotent replay (service returns the
   * existing row). Differentiating those two would require a deeper hook
   * into the service — for MVP we always return 201 since the client
   * doesn't behave differently either way.
   */
  @Post()
  @HttpCode(201)
  @Perm('create', 'payment')
  create(
    @ZodBody(createPaymentInputSchema) body: CreatePaymentInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<Payment> {
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new BadRequestException({
        error: 'IdempotencyKeyRequired',
        message: 'Idempotency-Key header is required (8–128 chars) for POST /payments',
      });
    }
    return this.paymentService.create(body, idempotencyKey);
  }

  /**
   * Confirm a pending payment. The acting admin's `sub` (user id) is captured
   * onto `Payment.confirmedByUserId` for accountability — use the `CurrentUser`
   * decorator to pull it off the verified JWT (no body field for it; can't
   * be spoofed by the caller).
   */
  @Post(':id/confirm')
  @HttpCode(200)
  @Perm('approve', 'payment')
  confirm(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ZodBody(confirmPaymentInputSchema) body: ConfirmPaymentInput,
    @CurrentUser('sub') userId: string,
  ): Promise<Payment> {
    return this.paymentService.confirm(id, userId, body.note);
  }

  /**
   * Reject a pending payment with a human-readable reason. Reason is stored
   * on the Payment row (unlike Invoice.void where it's audit-log only) — the
   * tenant needs to see WHY their slip was rejected to fix and re-upload.
   */
  @Post(':id/reject')
  @HttpCode(200)
  @Perm('approve', 'payment')
  reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ZodBody(rejectPaymentInputSchema) body: RejectPaymentInput,
  ): Promise<Payment> {
    return this.paymentService.reject(id, body.rejectionReason);
  }
}
