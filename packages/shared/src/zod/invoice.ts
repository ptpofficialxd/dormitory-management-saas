import { z } from 'zod';
import {
  companyIdSchema,
  isoUtcSchema,
  meterValueSchema,
  moneySchema,
  periodSchema,
  rateSchema,
  uuidSchema,
} from './primitives.js';

export const invoiceStatusSchema = z.enum([
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'void',
  'overdue',
]);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

export const invoiceItemKindSchema = z.enum([
  'rent',
  'water',
  'electric',
  'common_fee',
  'late_fee',
  'deposit',
  'other',
]);
export type InvoiceItemKind = z.infer<typeof invoiceItemKindSchema>;

/**
 * One line item on an invoice. `quantity * unitPrice = lineTotal` — service
 * layer MUST compute `lineTotal` using `money.mul` (never JS multiplication).
 *
 * Shapes:
 *   - `quantity`  → Decimal(12,2) — meter reading magnitudes (kWh, m³)
 *   - `unitPrice` → Decimal(10,4) — Thai electric tariff precision
 *   - `lineTotal` → Decimal(10,2) — money
 */
export const invoiceItemSchema = z.object({
  id: uuidSchema,
  invoiceId: uuidSchema,
  kind: invoiceItemKindSchema,
  description: z.string().min(1).max(255),
  quantity: meterValueSchema,
  unitPrice: rateSchema,
  lineTotal: moneySchema,
  readingId: uuidSchema.nullable(),
  sortOrder: z.number().int().min(0).default(0),
});
export type InvoiceItem = z.infer<typeof invoiceItemSchema>;

export const invoiceSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  contractId: uuidSchema,
  unitId: uuidSchema,
  /** FK to `tenant` (LIFF user), NOT `user` (admin/staff). */
  tenantId: uuidSchema,
  period: periodSchema,
  issueDate: isoUtcSchema,
  dueDate: isoUtcSchema,
  status: invoiceStatusSchema,
  subtotal: moneySchema,
  total: moneySchema,
  promptPayRef: z.string().max(512).nullable(),
  items: z.array(invoiceItemSchema).min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

/** Input for creating a new invoice — the service computes totals + lineTotal. */
export const createInvoiceInputSchema = z.object({
  contractId: uuidSchema,
  period: periodSchema,
  dueDate: isoUtcSchema,
  items: z
    .array(
      z.object({
        kind: invoiceItemKindSchema,
        description: z.string().min(1).max(255),
        quantity: meterValueSchema,
        unitPrice: rateSchema,
        readingId: uuidSchema.optional(),
        sortOrder: z.number().int().min(0).optional(),
      }),
    )
    .min(1),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceInputSchema>;

/** Input for `PATCH /invoices/:id` — status transitions only in MVP. */
export const updateInvoiceInputSchema = z.object({
  status: invoiceStatusSchema.optional(),
  dueDate: isoUtcSchema.optional(),
});
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceInputSchema>;
