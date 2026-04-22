import { Module } from '@nestjs/common';
import { InvoiceController } from './invoice.controller.js';
import { InvoiceService } from './invoice.service.js';
import { PromptPayService } from './prompt-pay.service.js';

/**
 * BillingModule — owns invoice generation, payment flow, slip handling, and
 * PromptPay QR rendering. Exports `PromptPayService` + `InvoiceService` so
 * downstream modules (PaymentService — Task #27, ReceiptService — Phase 1.5)
 * can stamp QRs / look up invoices without re-importing internals.
 *
 * Not @Global on purpose — only billing-related code should reach for the
 * QR generator. If a future module needs it (rare), it should explicitly
 * import BillingModule.
 */
@Module({
  controllers: [InvoiceController],
  providers: [PromptPayService, InvoiceService],
  exports: [PromptPayService, InvoiceService],
})
export class BillingModule {}
