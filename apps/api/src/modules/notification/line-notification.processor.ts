import { prisma, withTenant } from '@dorm/db';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUE_NAMES } from '../../common/queue/queue-names.js';
import { CompanyLineChannelService } from '../line/company-line-channel.service.js';
import { LineMessagingClient, LineMessagingPermanentError } from '../line/line-messaging.client.js';
import {
  renderInvoiceIssued,
  renderPaymentApproved,
  renderPaymentRejected,
} from './notification-templates.js';
import type { LineNotificationJobData } from './notification.types.js';

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
        `notification ${data.kind} skipped — tenant=${data.tenantId} not found in company=${data.companyId} (likely deleted)`,
      );
      return { ok: true, skipped: 'tenant-missing' };
    }

    if (!tenant.lineUserId) {
      // Most common skip reason: admin created the tenant + issued an
      // invoice before the human ever opened the LIFF app to bind. No
      // recipient = no push. Soft-skip.
      this.logger.debug(
        `notification ${data.kind} skipped — tenant=${data.tenantId} has no lineUserId (not bound yet)`,
      );
      return { ok: true, skipped: 'unbound-tenant' };
    }

    // Optional defensive check: don't push to retired tenants. Prevents
    // a "your bill is ready" message landing in the chat of someone who
    // moved out two months ago + has the OA still added.
    if (tenant.status !== 'active') {
      this.logger.debug(
        `notification ${data.kind} skipped — tenant=${data.tenantId} status=${tenant.status} (only push to active tenants)`,
      );
      return { ok: true, skipped: 'tenant-inactive' };
    }

    // 2. Resolve company channel + decrypted access token.
    const channel = await this.channelService.findByCompanyIdUnscoped(data.companyId);
    if (!channel) {
      this.logger.warn(
        `notification ${data.kind} skipped — company=${data.companyId} has no LINE channel configured`,
      );
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
        `notification ${data.kind} pushed tenant=${data.tenantId} invoice=${data.invoiceId}`,
      );
      return { ok: true };
    } catch (err) {
      if (err instanceof LineMessagingPermanentError) {
        // 4xx from LINE — most often: tenant blocked the OA, access token
        // revoked, or message validation failed. Retrying won't help.
        this.logger.warn(
          `notification ${data.kind} permanent-rejected by LINE (status=${err.status}) tenant=${data.tenantId} invoice=${data.invoiceId}: ${err.body}`,
        );
        return { ok: true, skipped: 'line-permanent-error' };
      }
      // Transient — let BullMQ retry per default backoff.
      throw err;
    }
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
        `notification ${job.data.kind} attempt ${attemptsMade}/${maxAttempts} failed tenant=${job.data.tenantId} invoice=${job.data.invoiceId}: ${err.message}`,
      );
      return;
    }
    this.logger.error(
      `notification ${job.data.kind} TERMINAL after ${attemptsMade} attempts tenant=${job.data.tenantId} invoice=${job.data.invoiceId}: ${err.message}`,
    );
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
    default:
      return assertNever(data);
  }
}

function assertNever(x: never): never {
  throw new Error(`Unhandled notification kind: ${JSON.stringify(x)}`);
}
