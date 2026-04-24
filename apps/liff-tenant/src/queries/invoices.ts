import {
  type InvoiceItemKind,
  type InvoiceStatus,
  invoiceItemKindSchema,
  invoiceStatusSchema,
} from '@dorm/shared/zod';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { type ApiError, apiGet } from '../lib/api.js';

/**
 * WIRE schemas for /me/invoices — JSON over the wire delivers Date as ISO
 * string, so we re-derive with `z.coerce.date()` instead of the server's
 * `z.date()`. Keeping the wire schema local avoids polluting @dorm/shared
 * with client-only date coercion.
 *
 * The structural shape MUST match `invoiceSchema` from @dorm/shared/zod.
 */

const invoiceItemWireSchema = z.object({
  id: z.string().uuid(),
  invoiceId: z.string().uuid(),
  kind: invoiceItemKindSchema,
  description: z.string(),
  quantity: z.string(),
  unitPrice: z.string(),
  lineTotal: z.string(),
  readingId: z.string().uuid().nullable(),
  sortOrder: z.number().int(),
});
export type InvoiceItemWire = z.infer<typeof invoiceItemWireSchema>;

export const invoiceWireSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  contractId: z.string().uuid(),
  unitId: z.string().uuid(),
  tenantId: z.string().uuid(),
  period: z.string(), // YYYY-MM
  issueDate: z.coerce.date(),
  dueDate: z.coerce.date(),
  status: invoiceStatusSchema,
  subtotal: z.string(),
  total: z.string(),
  promptPayRef: z.string().nullable(),
  items: z.array(invoiceItemWireSchema),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type InvoiceWire = z.infer<typeof invoiceWireSchema>;

export const invoicePageWireSchema = z.object({
  items: z.array(invoiceWireSchema),
  nextCursor: z.string().nullable(),
});
export type InvoicePageWire = z.infer<typeof invoicePageWireSchema>;

export type { InvoiceItemKind, InvoiceStatus };

// -------------------------------------------------------------------------
// Hooks
// -------------------------------------------------------------------------

/**
 * useInvoices — `GET /me/invoices` with the tenant Bearer token.
 *
 * Disabled until `token` is present (caller passes it from
 * `useTenantSession()` → only `authenticated` exposes a non-empty token).
 *
 * No filters in MVP — the LIFF tenant typically has 1 active contract and
 * sees their own bills only. Default pagination (limit 20) is enough for
 * a year's worth of monthly bills; "load more" can land later.
 */
export function useInvoices(opts: { token: string }) {
  return useQuery<InvoicePageWire, ApiError>({
    queryKey: ['me', 'invoices', 'list'],
    queryFn: () => apiGet('/me/invoices', invoicePageWireSchema, { token: opts.token }),
    enabled: Boolean(opts.token),
    // Bills update infrequently (admin batch-generates once per period).
    // 30s stale-time keeps the LIFF responsive without hammering the API.
    staleTime: 30_000,
    // No retry on auth errors — api.ts already cleared the token; the
    // session hook will re-mint on next render.
    retry: (failureCount, error) => {
      if ((error as ApiError).statusCode === 401) return false;
      return failureCount < 2;
    },
  });
}
