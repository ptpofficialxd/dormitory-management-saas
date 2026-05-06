import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../../common/queue/queue-names.js';
import {
  type LineNotificationAnnouncement,
  type LineNotificationInvoiceIssued,
  type LineNotificationJobData,
  type LineNotificationPaymentApproved,
  type LineNotificationPaymentRejected,
  buildNotificationJobId,
} from './notification.types.js';

/**
 * NotificationService — public surface for enqueueing transactional 1-to-1
 * LINE pushes from anywhere in the API.
 *
 * Callers (Task #84):
 *   - InvoiceService.issue / batchGenerate  →  enqueueInvoiceIssued
 *   - PaymentService.confirm                →  enqueuePaymentApproved
 *   - PaymentService.reject                 →  enqueuePaymentRejected
 *
 * Why service (vs. injecting `@InjectQueue` directly into every consumer):
 *   - Centralises the BullMQ jobId derivation (idempotency contract)
 *   - Hides BullMQ specifics — consumers think in domain terms (issue,
 *     approve, reject), not in queue mechanics
 *   - Lets us swap transport (e.g. Phase 2 add multicast / Flex messages)
 *     without touching every billing call site
 *
 * Idempotency contract:
 *   - Job ID = `notify:<kind>:<tenantId>:<invoiceId>` (see
 *     `buildNotificationJobId`)
 *   - BullMQ deduplicates same-id jobs WITHIN the queue's retention window
 *     (default: until the job hits `removeOnComplete` / `removeOnFail`)
 *   - That's enough for our flow: a tenant gets at most ONE push per (kind,
 *     invoice) — if InvoiceService.issue is retried after a partial failure,
 *     the second enqueue is a no-op
 *
 * Order-of-operations contract for callers:
 *   - Enqueue AFTER the DB commit + audit log emit. Queueing before commit
 *     risks pushing for an invoice the DB rolled back (split-brain).
 *   - This service swallows enqueue failures (returns void, logs) so a
 *     transient Redis hiccup doesn't take down a successful HTTP request.
 *     The DB row is the source of truth — a sweep job (Phase 2) can re-enqueue
 *     pushes for invoices that never received their notification.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.LINE_NOTIFICATION)
    private readonly queue: Queue<LineNotificationJobData>,
  ) {}

  /**
   * Push for a freshly-issued invoice. The push is best-effort:
   *   - Worker resolves `tenant.lineUserId` at dispatch time — null = skip
   *   - Worker resolves `CompanyLineChannel` — missing = skip
   *
   * Both skip cases are NOT errors from the caller's perspective; this
   * method always resolves with the queue position regardless.
   */
  async enqueueInvoiceIssued(args: Omit<LineNotificationInvoiceIssued, 'kind'>): Promise<void> {
    await this.enqueue({ kind: 'invoice_issued', ...args });
  }

  /**
   * Push when an admin confirms a payment. No payload extras beyond the
   * envelope — the rendered text already references `period` from the base.
   */
  async enqueuePaymentApproved(args: Omit<LineNotificationPaymentApproved, 'kind'>): Promise<void> {
    await this.enqueue({ kind: 'payment_approved', ...args });
  }

  /**
   * Push when an admin rejects a slip. `reason` is shown to the tenant
   * verbatim so it MUST be tenant-friendly (caller is responsible for
   * sanitising / translating internal codes).
   */
  async enqueuePaymentRejected(args: Omit<LineNotificationPaymentRejected, 'kind'>): Promise<void> {
    await this.enqueue({ kind: 'payment_rejected', ...args });
  }

  /**
   * Fan-out broadcast for COM-003. Caller (AnnouncementService.create)
   * pre-resolves the recipient list (active tenants in company with
   * `lineUserId` bound) and passes it in via `tenantIds`. We enqueue ONE
   * job per recipient — the worker handles per-tenant delivery + atomic
   * counter increments on the parent announcement.
   *
   * Why fan-out (vs LINE multicast which accepts up to 500 userIds/call):
   *   - Per-tenant retry isolation: a single 4xx from one userId blocking
   *     the whole batch would over-mark deliveredCount as failed
   *   - Per-tenant accounting: deliveredCount/failedCount are accurate to
   *     the recipient, not the batch
   *   - LINE multicast is a perf optimisation we can layer in later (Phase
   *     2) once we have a dorm large enough to feel the per-call overhead
   *
   * `totalRecipients` is snapshotted into every job's payload so each
   * worker can independently detect "I just processed the last one" via
   * an atomic compare-and-flip — no separate finalizer job needed.
   *
   * Returns void, swallows enqueue failures (same contract as the other
   * methods — caller's HTTP request stays green even if Redis hiccups; the
   * announcement row stays at status='sending' and an admin can retry by
   * re-POSTing with a fresh Idempotency-Key).
   */
  async enqueueAnnouncementBroadcast(args: {
    announcementId: string;
    companyId: string;
    companySlug: string;
    title: string;
    body: string;
    tenantIds: readonly string[];
  }): Promise<void> {
    const totalRecipients = args.tenantIds.length;
    if (totalRecipients === 0) {
      this.logger.warn(
        `enqueueAnnouncementBroadcast called with 0 recipients for announcement=${args.announcementId} — caller should have rejected upstream`,
      );
      return;
    }
    await Promise.all(
      args.tenantIds.map((tenantId) =>
        this.enqueue({
          kind: 'announcement',
          companyId: args.companyId,
          companySlug: args.companySlug,
          tenantId,
          announcementId: args.announcementId,
          title: args.title,
          body: args.body,
          totalRecipients,
        }),
      ),
    );
  }

  /**
   * Single internal entrypoint — every public method funnels through here.
   *
   * BullMQ jobId comes from the (kind, tenant, invoice) triple so that
   * concurrent retries (e.g. invoice batch retried after Redis blip) don't
   * fan out into duplicate pushes.
   *
   * Errors are caught and logged — see class JSDoc for the rationale.
   */
  private async enqueue(payload: LineNotificationJobData): Promise<void> {
    const jobId = buildNotificationJobId(payload);
    try {
      await this.queue.add(payload.kind, payload, { jobId });
    } catch (err) {
      // Producer-side failure (Redis down, queue closed, etc). The HTTP
      // request that triggered this still succeeded — log + move on.
      const resourceId =
        payload.kind === 'announcement' ? payload.announcementId : payload.invoiceId;
      this.logger.error(
        `Failed to enqueue ${payload.kind} for tenant=${payload.tenantId} resource=${resourceId}: ${(err as Error).message}`,
      );
    }
  }
}

// Re-export for AnnouncementService import ergonomics — keeps consumers from
// reaching into ./notification.types.js directly.
export type { LineNotificationAnnouncement };
