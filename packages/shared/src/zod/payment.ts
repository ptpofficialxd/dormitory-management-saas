import { z } from 'zod';
import {
  companyIdSchema,
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

export const paymentSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  invoiceId: uuidSchema,
  amount: moneySchema,
  method: paymentMethodSchema,
  status: paymentStatusSchema,
  slipId: uuidSchema.nullable(),
  confirmedAt: isoUtcSchema.nullable(),
  confirmedByUserId: uuidSchema.nullable(),
  note: z.string().max(500).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Payment = z.infer<typeof paymentSchema>;

/** Input for `POST /payments` (tenant uploading a slip-backed payment). */
export const createPaymentInputSchema = z.object({
  invoiceId: uuidSchema,
  amount: moneySchema,
  method: paymentMethodSchema,
  slipId: uuidSchema.optional(),
  note: z.string().max(500).optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentInputSchema>;

/** Input for `POST /payments/:id/confirm` (staff approving). */
export const confirmPaymentInputSchema = z.object({
  note: z.string().max(500).optional(),
});
export type ConfirmPaymentInput = z.infer<typeof confirmPaymentInputSchema>;
