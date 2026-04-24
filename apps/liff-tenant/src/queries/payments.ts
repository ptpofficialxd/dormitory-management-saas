import {
  type PaymentMethod,
  type PaymentStatus,
  paymentMethodSchema,
  paymentStatusSchema,
} from '@dorm/shared/zod';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { type ApiError, apiGet } from '../lib/api.js';

/**
 * WIRE schemas for /me/payments — JSON over the wire delivers Date as ISO
 * string. `paidAt` and `confirmedAt` are nullable on the schema; coerce
 * only when present.
 */

export const paymentWireSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  tenantId: z.string().uuid(),
  amount: z.string(),
  method: paymentMethodSchema,
  status: paymentStatusSchema,
  paidAt: z.coerce.date().nullable(),
  confirmedAt: z.coerce.date().nullable(),
  confirmedByUserId: z.string().uuid().nullable(),
  rejectionReason: z.string().nullable(),
  idempotencyKey: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PaymentWire = z.infer<typeof paymentWireSchema>;

export const paymentPageWireSchema = z.object({
  items: z.array(paymentWireSchema),
  nextCursor: z.string().nullable(),
});
export type PaymentPageWire = z.infer<typeof paymentPageWireSchema>;

export type { PaymentMethod, PaymentStatus };

// -------------------------------------------------------------------------
// Hooks
// -------------------------------------------------------------------------

/**
 * useInvoicePayments — `GET /me/payments?invoiceId=:id` filtered to one
 * invoice. Used by the invoice detail page to render payment history (one
 * row per attempted slip / cash record).
 *
 * Bypasses the cursor for MVP — payments per invoice are O(1-3); the API's
 * default page size of 20 is more than enough.
 */
export function useInvoicePayments(opts: { token: string; invoiceId: string }) {
  return useQuery<PaymentPageWire, ApiError>({
    queryKey: ['me', 'payments', 'by-invoice', opts.invoiceId],
    queryFn: () =>
      apiGet(
        `/me/payments?invoiceId=${encodeURIComponent(opts.invoiceId)}`,
        paymentPageWireSchema,
        {
          token: opts.token,
        },
      ),
    enabled: Boolean(opts.token) && Boolean(opts.invoiceId),
    // Tenant just submitted a slip → wants to see the new pending row.
    // Short stale-time keeps "ดูรายละเอียด" responsive after upload.
    staleTime: 5_000,
    retry: (failureCount, error) => {
      if ((error as ApiError).statusCode === 401) return false;
      return failureCount < 2;
    },
  });
}
