import { Module } from '@nestjs/common';
import { InvoiceController } from './invoice.controller.js';
import { InvoiceService } from './invoice.service.js';
import { MeInvoiceController } from './me-invoice.controller.js';
import { PaymentController } from './payment.controller.js';
import { PaymentService } from './payment.service.js';
import { PromptPayService } from './prompt-pay.service.js';
import { SlipController } from './slip.controller.js';
import { SlipService } from './slip.service.js';

/**
 * BillingModule — owns invoice generation, payment flow, slip handling, and
 * PromptPay QR rendering. Exports `PromptPayService`, `InvoiceService`,
 * `PaymentService`, and `SlipService` so downstream modules
 * (ReceiptService — Phase 1.5, ReconciliationService — Phase 2) can stamp
 * QRs / look up invoices / sum payments / fetch slip URLs without
 * re-importing internals.
 *
 * StorageService is injected via the `@Global()` StorageModule — no
 * explicit import needed here.
 *
 * Not @Global on purpose — only billing-related code should reach for the
 * QR generator. If a future module needs it (rare), it should explicitly
 * import BillingModule.
 */
@Module({
  controllers: [InvoiceController, MeInvoiceController, PaymentController, SlipController],
  providers: [PromptPayService, InvoiceService, PaymentService, SlipService],
  exports: [PromptPayService, InvoiceService, PaymentService, SlipService],
})
export class BillingModule {}
