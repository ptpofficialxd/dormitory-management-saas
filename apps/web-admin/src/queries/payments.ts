import {
  type ConfirmPaymentInput,
  type PaymentMethod,
  type PaymentStatus,
  type RejectPaymentInput,
  confirmPaymentInputSchema,
  paymentSchema,
  rejectPaymentInputSchema,
} from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schemas for the Payment API.
 *
 * `paidAt` and `confirmedAt` are nullable on the wire — coerce only when
 * present. Same z.coerce.date() rationale as queries/invoices.ts.
 */

export const paymentWireSchema = paymentSchema.extend({
  paidAt: z.coerce.date().nullable(),
  confirmedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PaymentWire = z.infer<typeof paymentWireSchema>;

/** Cursor page envelope returned by `GET /c/:slug/payments`. */
export const paymentPageSchema = z.object({
  items: z.array(paymentWireSchema),
  nextCursor: z.string().nullable(),
});
export type PaymentPage = z.infer<typeof paymentPageSchema>;

// Re-export shared input schemas/types so consumers don't dual-import.
export { confirmPaymentInputSchema, rejectPaymentInputSchema };
export type { ConfirmPaymentInput, PaymentMethod, PaymentStatus, RejectPaymentInput };
