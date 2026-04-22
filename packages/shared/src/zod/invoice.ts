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

// =========================================================================
// Batch generation — manager-triggered "create all invoices for period XYZ".
// Runs per-active-contract; skips contracts missing readings (water/electric)
// rather than failing the whole batch. Per AskUserQuestion confirmation:
//   - status=draft (manager reviews then bulk-issues)
//   - skip+report missing readings (don't estimate, don't fail batch)
//   - additionalItems: optional flat fees (common_fee / deposit) injected
//     into every generated invoice; service rejects negative quantities
// =========================================================================

/**
 * Auto-generated line item from a per-batch fee (e.g. monthly common fee).
 * Service applies the SAME `additionalItem` set to every invoice in the
 * batch — use a separate single-invoice POST for one-off charges.
 *
 * Constraints:
 *   - `kind` excludes `water` / `electric` (those come from readings)
 *   - `kind` excludes `late_fee` (computed from overdue invoices, not batches)
 *   - `quantity * unitPrice` must fit Decimal(10,2); service enforces.
 */
export const batchAdditionalItemSchema = z.object({
  kind: z.enum(['common_fee', 'deposit', 'other']),
  description: z.string().min(1).max(255),
  quantity: meterValueSchema,
  unitPrice: rateSchema,
});
export type BatchAdditionalItem = z.infer<typeof batchAdditionalItemSchema>;

/**
 * Input for `POST /c/:slug/invoices/batch`.
 *
 * `propertyId` is optional — omit to bill ALL active contracts in the
 * company (single-property MVP), supply to scope to one building once
 * Phase 2 multi-property arrives.
 *
 * `dueDayOfMonth` clamped to 1-28 to dodge the Feb-30 / Apr-31 trap.
 * Most Thai dorms bill on day-5 of next month.
 */
export const batchGenerateInvoicesInputSchema = z.object({
  period: periodSchema,
  propertyId: uuidSchema.optional(),
  dueDayOfMonth: z.number().int().min(1).max(28),
  additionalItems: z.array(batchAdditionalItemSchema).max(10).optional(),
});
export type BatchGenerateInvoicesInput = z.infer<typeof batchGenerateInvoicesInputSchema>;

/**
 * Per-unit reason a contract was skipped during batch generation.
 * Mirrored 1:1 to the response so manager UI can show "Fix these and re-run".
 */
export const batchSkipReasonSchema = z.enum([
  'missing_water_reading',
  'missing_electric_reading',
  'duplicate_invoice', // Already exists for (contractId, period)
  'inactive_contract',
  'no_active_contract',
]);
export type BatchSkipReason = z.infer<typeof batchSkipReasonSchema>;

export const batchGenerateInvoicesResultSchema = z.object({
  /** UUIDs of newly-created draft invoices. Use for follow-up bulk-issue. */
  generatedInvoiceIds: z.array(uuidSchema),
  /** Units that couldn't be billed — surface to manager UI. */
  skipped: z.array(
    z.object({
      unitId: uuidSchema,
      contractId: uuidSchema.nullable(),
      reason: batchSkipReasonSchema,
    }),
  ),
});
export type BatchGenerateInvoicesResult = z.infer<typeof batchGenerateInvoicesResultSchema>;

// =========================================================================
// Single-invoice transitions — issue / void
// =========================================================================

/**
 * Issue endpoint takes only the path param; no body. Service:
 *   - Asserts current status === 'draft'
 *   - Generates `promptPayRef` from company PromptPay config + invoice total
 *   - Flips status to `issued`, sets a fresh `issueDate`
 *   - Triggers LINE notify in a follow-up phase (out of MVP scope here)
 *
 * Idempotency: re-issuing a draft is a no-op + 200 (we treat the operation
 * as commutative). Re-issuing a non-draft is 409 to surface UX bugs early.
 */
export const issueInvoiceInputSchema = z.object({}).strict();
export type IssueInvoiceInput = z.infer<typeof issueInvoiceInputSchema>;

/**
 * Void requires a human-readable reason — written to `audit_log` so
 * end-of-month reconciliation can answer "why were 3 invoices voided?".
 *
 * Cap at 512 chars (Postgres VARCHAR sized for free-text + bilingual).
 */
export const voidInvoiceInputSchema = z.object({
  reason: z.string().min(4).max(512),
});
export type VoidInvoiceInput = z.infer<typeof voidInvoiceInputSchema>;

// =========================================================================
// List / search — admin dashboard + LIFF tenant own-bills view
// =========================================================================

/**
 * Query for `GET /c/:slug/invoices`. All filters AND-combined.
 *
 * `tenantId` is enforced by the controller for LIFF callers (they may only
 * see their own); admin callers may pass any value within the company.
 *
 * `cursor` is opaque base64 of `(createdAt, id)` per CLAUDE.md pagination
 * pattern — service decodes/encodes, callers treat it as a string.
 */
export const listInvoicesQuerySchema = z.object({
  status: invoiceStatusSchema.optional(),
  period: periodSchema.optional(),
  tenantId: uuidSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
