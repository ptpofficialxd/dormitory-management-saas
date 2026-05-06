/**
 * Internal types for the LINE notification queue (Task #83 + #105).
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
  'announcement',
] as const;

export type LineNotificationKind = (typeof LINE_NOTIFICATION_KINDS)[number];

/**
 * Common envelope every job payload carries — recipient resolution + LIFF
 * deep-link construction need these regardless of `kind`.
 *
 * Resource-specific fields (invoiceId/period for invoice/payment kinds,
 * announcementId/title/body for announcements) live on the per-kind shapes
 * below. Don't add invoice-only fields here; that would force the
 * announcement payload (which has neither) to lie via empty strings.
 */
type LineNotificationCommon = {
  companyId: string;
  companySlug: string;
  tenantId: string;
};

/**
 * Subset shared by invoice + payment kinds — both are scoped to a specific
 * invoice + billing period. Kept separate from Common so the announcement
 * branch doesn't have to carry junk values.
 */
type LineNotificationInvoiceBase = LineNotificationCommon & {
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
export type LineNotificationInvoiceIssued = LineNotificationInvoiceBase & {
  kind: 'invoice_issued';
  totalAmount: string;
  dueDate: string;
};

/**
 * PAYMENT_APPROVED — emitted by `PaymentService.confirm`. No payload extras
 * beyond the base — the period is enough context for the tenant to know
 * which bill we approved.
 */
export type LineNotificationPaymentApproved = LineNotificationInvoiceBase & {
  kind: 'payment_approved';
};

/**
 * PAYMENT_REJECTED — emitted by `PaymentService.reject`. Reason text is shown
 * verbatim to the tenant so they know what to fix on the next slip upload.
 */
export type LineNotificationPaymentRejected = LineNotificationInvoiceBase & {
  kind: 'payment_rejected';
  reason: string;
};

/**
 * ANNOUNCEMENT — emitted by `AnnouncementService.create` (when sendNow=true)
 * via `NotificationService.enqueueAnnouncementBroadcast`. One job per
 * recipient tenant. The processor pushes the rendered text + atomically
 * increments the parent announcement's `deliveredCount` / `failedCount`,
 * flipping `status` to `sent` / `failed` once
 * `deliveredCount + failedCount == totalRecipients`.
 *
 * `totalRecipients` is the snapshot recipient count from the producer
 * (active tenants with `lineUserId` at enqueue time). Stored in the payload
 * so the worker can detect terminal-batch state without a separate query.
 *
 * `title` + `body` are inlined from the announcement row at enqueue time —
 * editing the announcement after send (Phase 2) won't retroactively change
 * what the queue dispatches.
 */
export type LineNotificationAnnouncement = LineNotificationCommon & {
  kind: 'announcement';
  announcementId: string;
  title: string;
  body: string;
  totalRecipients: number;
};

/**
 * Union of every job payload shape. The processor switches on `kind` and TS
 * narrows `vars` automatically.
 */
export type LineNotificationJobData =
  | LineNotificationInvoiceIssued
  | LineNotificationPaymentApproved
  | LineNotificationPaymentRejected
  | LineNotificationAnnouncement;

/**
 * Build the BullMQ jobId for a notification. The (kind, tenant, resource)
 * triple is the unique idempotency key — re-enqueueing the same triple
 * within BullMQ's retention window is a no-op (Bull dedup behaviour).
 *
 * `resource` is the invoiceId for invoice/payment kinds, the
 * announcementId for announcements. Centralised here so the dedup key is
 * authoritative + stays in sync with the discriminator.
 *
 * Examples:
 *   notify:invoice_issued:T-abc:I-xyz
 *   notify:payment_approved:T-abc:I-xyz
 *   notify:payment_rejected:T-abc:I-xyz
 *   notify:announcement:T-abc:A-uvw
 */
export function buildNotificationJobId(payload: LineNotificationJobData): string {
  const resourceId = payload.kind === 'announcement' ? payload.announcementId : payload.invoiceId;
  return `notify:${payload.kind}:${payload.tenantId}:${resourceId}`;
}
