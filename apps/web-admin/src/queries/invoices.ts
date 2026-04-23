import {
  type CreateInvoiceInput,
  type InvoiceStatus,
  createInvoiceInputSchema,
  invoiceItemSchema,
  invoiceSchema,
  invoiceStatusSchema,
} from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schemas for the Invoice API.
 *
 * Same z.coerce.date() rationale as queries/properties.ts — JSON-over-wire
 * delivers ISO strings; we re-derive wire variants here to keep the typed
 * parse on the client zero-cost.
 *
 * `items` and the timestamps are the only fields that need coercion.
 * `period` stays a string ("YYYY-MM"), money stays a Decimal-string.
 */

const invoiceItemWireSchema = invoiceItemSchema.extend({
  // No date fields on items — but extend() to keep the alias clear.
});
export type InvoiceItemWire = z.infer<typeof invoiceItemWireSchema>;

export const invoiceWireSchema = invoiceSchema.extend({
  issueDate: z.coerce.date(),
  dueDate: z.coerce.date(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  items: z.array(invoiceItemWireSchema),
});
export type InvoiceWire = z.infer<typeof invoiceWireSchema>;

/** Cursor page envelope returned by `GET /c/:slug/invoices`. */
export const invoicePageSchema = z.object({
  items: z.array(invoiceWireSchema),
  nextCursor: z.string().nullable(),
});
export type InvoicePage = z.infer<typeof invoicePageSchema>;

// Re-export shared input schema/type so consumers don't have to dual-import.
export { createInvoiceInputSchema, invoiceStatusSchema };
export type { CreateInvoiceInput, InvoiceStatus };
