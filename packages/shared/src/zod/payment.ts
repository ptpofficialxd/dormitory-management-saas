import { z } from 'zod';
import {
  companyIdSchema,
  idempotencyKeySchema,
  isoUtcSchema,
  moneySchema,
  uuidSchema,
} from './primitives.js';

export const paymentStatusSchema = z.enum([
  'pending', // slip uploaded, awaiting review
  'confirmed',
  'rejected',
]);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const paymentMethodSchema = z.enum(['promptpay', 'cash', 'bank_transfer']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

/**
 * Persistent payment shape. `idempotencyKey` is required because every
 * write path creates it (CLAUDE.md §3.10). The matching `Slip` row is a
 * reverse relation (`slip.paymentId @unique`) — not a column on Payment.
 */
export const paymentSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  invoiceId: uuidSchema,
  /** FK to `tenant` (LIFF user). */
  tenantId: uuidSchema,
  amount: moneySchema,
  method: paymentMethodSchema,
  status: paymentStatusSchema,
  paidAt: isoUtcSchema.nullable(),
  confirmedAt: isoUtcSchema.nullable(),
  confirmedByUserId: uuidSchema.nullable(),
  rejectionReason: z.string().max(512).nullable(),
  idempotencyKey: idempotencyKeySchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Payment = z.infer<typeof paymentSchema>;

/**
 * Input for `POST /payments` — tenant-initiated, slip-backed.
 * `idempotencyKey` MUST come from the `Idempotency-Key` HTTP header, not
 * from the JSON body (CLAUDE.md §3.10). The service layer attaches it.
 * A slip is created in a separate `POST /slips` call and linked server-side.
 */
export const createPaymentInputSchema = z.object({
  invoiceId: uuidSchema,
  amount: moneySchema,
  method: paymentMethodSchema,
  paidAt: isoUtcSchema.optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentInputSchema>;

/** Input for `POST /payments/:id/confirm` (staff approving). */
export const confirmPaymentInputSchema = z.object({
  note: z.string().max(512).optional(),
});
export type ConfirmPaymentInput = z.infer<typeof confirmPaymentInputSchema>;

/** Input for `POST /payments/:id/reject` (staff rejecting a slip). */
export const rejectPaymentInputSchema = z.object({
  rejectionReason: z.string().min(1).max(512),
});
export type RejectPaymentInput = z.infer<typeof rejectPaymentInputSchema>;
