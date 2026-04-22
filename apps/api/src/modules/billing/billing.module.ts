import { Module } from '@nestjs/common';
import { PromptPayService } from './prompt-pay.service.js';

/**
 * BillingModule — owns invoice generation, payment flow, slip handling, and
 * PromptPay QR rendering. Exports `PromptPayService` so InvoiceService
 * (added next) and ReceiptService (Phase 1.5) can stamp QRs into invoice
 * detail responses + PDFs without re-importing the qrcode library.
 *
 * Not @Global on purpose — only billing-related code should reach for the
 * QR generator. If a future module needs it (rare), it should explicitly
 * import BillingModule.
 */
@Module({
  providers: [PromptPayService],
  exports: [PromptPayService],
})
export class BillingModule {}
