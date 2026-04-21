import { z } from 'zod';
import {
  companyIdSchema,
  isoUtcSchema,
  moneySchema,
  periodSchema,
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
 */
export const invoiceItemSchema = z.object({
  id: uuidSchema,
  kind: invoiceItemKindSchema,
  description: z.string().min(1).max(200),
  quantity: moneySchema,
  unitPrice: moneySchema,
  lineTotal: moneySchema,
});
export type InvoiceItem = z.infer<typeof invoiceItemSchema>;

export const invoiceSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  unitId: uuidSchema,
  contractId: uuidSchema,
  tenantUserId: uuidSchema,
  period: periodSchema,
  issueDate: isoUtcSchema,
  dueDate: isoUtcSchema,
  status: invoiceStatusSchema,
  subtotal: moneySchema,
  total: moneySchema,
  promptPayRef: z.string().nullable(),
  items: z.array(invoiceItemSchema).min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

/** Input for creating a new invoice — the service computes totals. */
export const createInvoiceInputSchema = z.object({
  contractId: uuidSchema,
  period: periodSchema,
  dueDate: isoUtcSchema,
  items: z
    .array(
      z.object({
        kind: invoiceItemKindSchema,
        description: z.string().min(1).max(200),
        quantity: moneySchema,
        unitPrice: moneySchema,
      }),
    )
    .min(1),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceInputSchema>;
