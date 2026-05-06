import { prisma, withTenant } from '@dorm/db';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUE_NAMES } from '../../common/queue/queue-names.js';
import { CompanyLineChannelService } from '../line/company-line-channel.service.js';
import { LineMessagingClient, LineMessagingPermanentError } from '../line/line-messaging.client.js';
import {
  renderAnnouncement,
  renderInvoiceIssued,
  renderPaymentApproved,
  renderPaymentRejected,
} from './notification-templates.js';
import type {
  LineNotificationAnnouncement,
  LineNotificationJobData,
} from './notification.types.js';

/**
 * BullMQ worker for the `line-notification` queue (Task #83).
 *
 * Pipeline per job:
 *
 *   1. Resolve tenant.lineUserId (RLS-scoped read with companyId from job)
 *      → null = tenant hasn't bound LIFF yet → soft-skip (return ok), no
 *        retry
 *
 *   2. Resolve CompanyLineChannel (bypass-RLS lookup — no request context
 *      in workers)
 *      → null = company removed the channel → soft-skip + warn (could also
 *        argue PermanentJobError; we choose soft-skip so an admin re-adding
 *        a channel later doesn't surface a stale "failed" trail)
 *
 *   3. Render the Thai template per `kind` (TS narrows the discriminator)
 *
 *   4. POST to LINE Messaging API via shared `LineMessagingClient`
 *      → `LineMessagingPermanentError` (4xx) → log + done; common case is
 *        the user blocked the OA — retrying will never succeed
 *      → any other error → throw → BullMQ retries with default backoff
 *        (3 attempts, exponential 1s base — see queue.module.ts)
 *
 * Why soft-skip on missing lineUserId / channel:
 *   - These are EXPECTED states during the rollout (tenant onboarding lag,
 *     OA hasn't been wired yet). Treating them as failures would clutter
 *     the failure log + waste retry budget.
 *   - Permanent state changes that prevent push (tenant unbound LIFF mid-
 *     flight, OA suspended) are also captured here — same rationale.
 *
 * RLS scope:
 *   - Tenant lookup uses non-bypass `withTenant({ companyId })` because we
 *     have a known scope from the job payload. This is stricter than the
 *     channel lookup (which uses bypass because it pre-dates context).
 *   - Same pattern as `LineEventProcessor.process` (Task #40).
 *
 * Idempotency:
 *   - The producer (`NotificationService.enqueue`) sets a deterministic
 *     jobId, so re-enqueueing the same (kind, tenant, invoice) triple is
 *     a no-op at the queue layer
 *   - LINE push itself isn't idempotent server-side, but our jobId guard
 *     prevents the worker from ever firing twice for the same triple
 */
@Processor(QUEUE_NAMES.LINE_NOTIFICATION)
export class LineNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(LineNotificationProcessor.name);

  constructor(
    private readonly channelService: CompanyLineChannelService,
    private readonly messaging: LineMessagingClient,
  ) {
    super();
  }

  async process(job: Job<LineNotificationJobData>): Promise<{ ok: true; skipped?: string }> {
    const data = job.data;

    // 1. Resolve tenant.lineUserId — RLS-scoped read.
    const tenant = await withTenant({ companyId: data.companyId }, () =>
      prisma.tenant.findUnique({
        where: { id: data.tenantId },
        select: { lineUserId: true, status: true },
      }),
    );

    if (!tenant) {
      this.logger.warn(
        `notification ${data.kind} skipped — tenant=${data.tenantId} not found in company=${data.companyId} (likely deleted) [${describeResource(data)}]`,
      );
      await this.recordAnnouncementOutcome(data, 'failed');
      return { ok: true, skipped: 'tenant-missing' };
    }

    if (!tenant.lineUserId) {
      // Most common skip reason: admin created the tenant + issued an
      // invoice before the human ever opened the LIFF app to bind. No
      // recipient = no push. Soft-skip on the queue side; for
      // announcement broadcasts we still count this as a failed delivery
      // so the admin's "delivered/failed" UI matches recipient reality.
      this.logger.debug(
        `notification ${data.kind} skipped — tenant=${data.tenantId} has no lineUserId (not bound yet) [${describeResource(data)}]`,
      );
      await this.recordAnnouncementOutcome(data, 'failed');
      return { ok: true, skipped: 'unbound-tenant' };
    }

    // Optional defensive check: don't push to retired tenants. Prevents
    // a "your bill is ready" message landing in the chat of someone who
    // moved out two months ago + has the OA still added. The producer
    // pre-filters for active tenants, but status can change between
    // enqueue + dispatch — count as failed here.
    if (tenant.status !== 'active') {
      this.logger.debug(
        `notification ${data.kind} skipped — tenant=${data.tenantId} status=${tenant.status} (only push to active tenants) [${describeResource(data)}]`,
      );
      await this.recordAnnouncementOutcome(data, 'failed');
      return { ok: true, skipped: 'tenant-inactive' };
    }

    // 2. Resolve company channel + decrypted access token.
    const channel = await this.channelService.findByCompanyIdUnscoped(data.companyId);
    if (!channel) {
      this.logger.warn(
        `notification ${data.kind} skipped — company=${data.companyId} has no LINE channel configured [${describeResource(data)}]`,
      );
      await this.recordAnnouncementOutcome(data, 'failed');
      return { ok: true, skipped: 'channel-missing' };
    }

    // 3. Render the Thai template. Switch is exhaustive — TS narrows `data`
    //    to the right shape per branch, so `renderX(data)` accepts cleanly.
    const text = renderText(data);

    // 4. Push. Permanent errors are absorbed; transient bubble up for retry.
    try {
      await this.messaging.pushMessage({
        to: tenant.lineUserId,
        messages: [{ type: 'text', text }],
        accessToken: channel.channelAccessToken,
      });
      this.logger.debug(
        `notification ${data.kind} pushed tenant=${data.tenantId} [${describeResource(data)}]`,
      );
      await this.recordAnnouncementOutcome(data, 'delivered');
      return { ok: true };
    } catch (err) {
      if (err instanceof LineMessagingPermanentError) {
        // 4xx from LINE — most often: tenant blocked the OA, access token
        // revoked, or message validation failed. Retrying won't help.
        this.logger.warn(
          `notification ${data.kind} permanent-rejected by LINE (status=${err.status}) tenant=${data.tenantId} [${describeResource(data)}]: ${err.body}`,
        );
        await this.recordAnnouncementOutcome(data, 'failed');
        return { ok: true, skipped: 'line-permanent-error' };
      }
      // Transient — let BullMQ retry per default backoff. The terminal
      // outcome (after all retries exhaust) is captured by `onFailed`
      // which calls `recordAnnouncementOutcome(data, 'failed')` there.
      throw err;
    }
  }

  /**
   * For announcement jobs, atomically increment the parent announcement's
   * `deliveredCount` or `failedCount`, then check if this was the last
   * recipient. If yes, flip `status` from `sending` to `sent` (any
   * deliveries happened) or `failed` (zero deliveries). For other kinds,
   * this is a no-op.
   *
   * Race safety:
   *   - Each worker increments via Prisma's `{ increment: 1 }` operator
   *     which compiles to `UPDATE ... SET col = col + 1` — atomic at the
   *     row level, no read-modify-write window.
   *   - Terminal flip uses a conditional `WHERE status = 'sending'` so
   *     the second worker that crosses the threshold is a no-op (Prisma
   *     returns count=0 silently).
   *
   * Failure mode: if Redis publishes the message but the DB write fails
   * (transient PG hiccup), the announcement might stay at `sending`
   * forever with under-counted stats. Phase 1 wishlist: a sweep job that
   * scans for stale `sending` rows + reconciles from queue history. For
   * MVP, admin can manually re-broadcast (different Idempotency-Key) if
   * stuck.
   */
  private async recordAnnouncementOutcome(
    data: LineNotificationJobData,
    outcome: 'delivered' | 'failed',
  ): Promise<void> {
    if (data.kind !== 'announcement') return;
    try {
      await this.bumpAnnouncementCounter(data, outcome);
    } catch (err) {
      // We've already logged + the push side-effect (or skip) is
      // committed. Counter drift is annoying but not corrupting — log
      // loud + keep moving.
      this.logger.error(
        `failed to ${outcome === 'delivered' ? 'increment delivered' : 'increment failed'} on announcement=${data.announcementId}: ${(err as Error).message}`,
      );
    }
  }

  private async bumpAnnouncementCounter(
    data: LineNotificationAnnouncement,
    outcome: 'delivered' | 'failed',
  ): Promise<void> {
    await withTenant({ companyId: data.companyId }, async () => {
      const updated = await prisma.announcement.update({
        where: { id: data.announcementId },
        data:
          outcome === 'delivered'
            ? { deliveredCount: { increment: 1 } }
            : { failedCount: { increment: 1 } },
        select: { deliveredCount: true, failedCount: true },
      });

      const accounted = updated.deliveredCount + updated.failedCount;
      if (accounted < data.totalRecipients) {
        return; // not the last worker; stay 'sending'
      }

      // Terminal: flip status. Conditional `where: { status: 'sending' }`
      // makes the second-finisher a silent no-op (updateMany returns
      // count=0 instead of throwing).
      const terminalStatus: 'sent' | 'failed' = updated.deliveredCount > 0 ? 'sent' : 'failed';
      await prisma.announcement.updateMany({
        where: { id: data.announcementId, status: 'sending' },
        data: { status: terminalStatus, sentAt: new Date() },
      });
    });
  }

  /**
   * Worker-level failure listener. Mirrors `LineEventProcessor.onFailed`
   * pattern — log only, no DB row to flip (notifications are fire-and-
   * forget per Task #83 design; a Phase 2 reconcile sweep can re-enqueue
   * by scanning recent invoices/payments without a corresponding queue
   * job).
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<LineNotificationJobData> | undefined, err: Error): void {
    if (!job) {
      this.logger.warn(
        `notification job arrived undefined in failed listener (stalled + removed): ${err.message}`,
      );
      return;
    }
    const attemptsMade = job.attemptsMade ?? 1;
    const maxAttempts = job.opts?.attempts ?? 1;
    const exhausted = attemptsMade >= maxAttempts;

    if (!exhausted) {
      this.logger.warn(
        `notification ${job.data.kind} attempt ${attemptsMade}/${maxAttempts} failed tenant=${job.data.tenantId} [${describeResource(job.data)}]: ${err.message}`,
      );
      return;
    }
    this.logger.error(
      `notification ${job.data.kind} TERMINAL after ${attemptsMade} attempts tenant=${job.data.tenantId} [${describeResource(job.data)}]: ${err.message}`,
    );

    // Announcement-only: the terminal-failed retry counts toward
    // failedCount so the admin sees an accurate "X delivered / Y failed"
    // even when delivery never connected (transient errors that exhausted
    // every retry). We can't `await` here (the @OnWorkerEvent listener is
    // sync per BullMQ contract), so fire-and-forget with .catch.
    if (job.data.kind === 'announcement') {
      this.recordAnnouncementOutcome(job.data, 'failed').catch((bumpErr) => {
        this.logger.error(
          `failed to bump announcement=${(job.data as LineNotificationAnnouncement).announcementId} failedCount in onFailed listener: ${(bumpErr as Error).message}`,
        );
      });
    }
  }
}

/**
 * Tiny dispatcher — switches the discriminated union to the right renderer.
 * Extracted for unit-testability (no need to spin a full Nest module).
 *
 * The exhaustiveness check (`assertNever` returning never on the default)
 * means adding a new `kind` to the union surfaces a TS error here until
 * the new branch lands.
 */
function renderText(data: LineNotificationJobData): string {
  switch (data.kind) {
    case 'invoice_issued':
      return renderInvoiceIssued(data);
    case 'payment_approved':
      return renderPaymentApproved(data);
    case 'payment_rejected':
      return renderPaymentRejected(data);
    case 'announcement':
      return renderAnnouncement(data);
    default:
      return assertNever(data);
  }
}

/**
 * Render a human-readable resource identifier for log lines. invoice +
 * payment kinds get `invoice=<id>`; announcement gets `announcement=<id>`.
 * Centralised so the whole worker speaks the same log vocabulary.
 */
function describeResource(data: LineNotificationJobData): string {
  if (data.kind === 'announcement') {
    return `announcement=${data.announcementId}`;
  }
  return `invoice=${data.invoiceId}`;
}

function assertNever(x: never): never {
  throw new Error(`Unhandled notification kind: ${JSON.stringify(x)}`);
}
