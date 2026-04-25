/**
 * Internal types for the LINE notification queue (Task #83).
 *
 * These shapes describe BullMQ job payloads — never exposed to HTTP clients
 * or persisted in DB. Kept LOCAL to apps/api (not in @dorm/shared) because:
 *   - The producer (NotificationService) and consumer (LineNotificationProcessor)
 *     run in the same Node process today
 *   - We want forward-compat freedom to add fields without touching shared
 *
 * A discriminated union on `kind` lets the processor narrow `vars` to the
 * exact shape that template requires — adding a new notification type means
 * one new branch in the union + one new render function in templates, no
 * casting tricks.
 *
 * Why we embed `companySlug` in the payload (vs resolving in the worker):
 *   - Slugs are immutable identifiers per CLAUDE.md (treated as PK-like)
 *   - Avoids an extra Prisma round-trip per push
 *   - Snapshot is fine because slug doesn't change between enqueue + dispatch
 */

/** Discriminator literals for `kind`. Add new ones below in the union. */
export const LINE_NOTIFICATION_KINDS = [
  'invoice_issued',
  'payment_approved',
  'payment_rejected',
] as const;

export type LineNotificationKind = (typeof LINE_NOTIFICATION_KINDS)[number];

/**
 * Common envelope every job payload carries — recipient resolution + LIFF
 * deep-link construction need these regardless of `kind`.
 */
type LineNotificationBase = {
  companyId: string;
  companySlug: string;
  tenantId: string;
  invoiceId: string;
  /** Billing period `YYYY-MM`. Used in template body + as part of jobId. */
  period: string;
};

/**
 * INVOICE_ISSUED — emitted when an admin issues / batch-generates an invoice.
 *
 * `totalAmount` is a money string (Decimal-safe per ADR-0005), `dueDate` is
 * `YYYY-MM-DD` (whatever was on the invoice row at issue time).
 */
export type LineNotificationInvoiceIssued = LineNotificationBase & {
  kind: 'invoice_issued';
  totalAmount: string;
  dueDate: string;
};

/**
 * PAYMENT_APPROVED — emitted by `PaymentService.confirm`. No payload extras
 * beyond the base — the period is enough context for the tenant to know
 * which bill we approved.
 */
export type LineNotificationPaymentApproved = LineNotificationBase & {
  kind: 'payment_approved';
};

/**
 * PAYMENT_REJECTED — emitted by `PaymentService.reject`. Reason text is shown
 * verbatim to the tenant so they know what to fix on the next slip upload.
 */
export type LineNotificationPaymentRejected = LineNotificationBase & {
  kind: 'payment_rejected';
  reason: string;
};

/**
 * Union of every job payload shape. The processor switches on `kind` and TS
 * narrows `vars` automatically.
 */
export type LineNotificationJobData =
  | LineNotificationInvoiceIssued
  | LineNotificationPaymentApproved
  | LineNotificationPaymentRejected;

/**
 * Build the BullMQ jobId for a notification. The (kind, tenant, invoice)
 * triple is the unique idempotency key — re-enqueueing the same triple
 * within BullMQ's retention window is a no-op (Bull dedup behaviour).
 *
 * Examples:
 *   notify:invoice_issued:T-abc:I-xyz
 *   notify:payment_approved:T-abc:I-xyz
 *   notify:payment_rejected:T-abc:I-xyz
 */
export function buildNotificationJobId(args: {
  kind: LineNotificationKind;
  tenantId: string;
  invoiceId: string;
}): string {
  return `notify:${args.kind}:${args.tenantId}:${args.invoiceId}`;
}
