import { prisma, withTenant } from '@dorm/db';
import { type LineWebhookEvent, lineWebhookEventSchema } from '@dorm/shared/zod';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUE_NAMES } from '../../common/queue/queue-names.js';
import { CompanyLineChannelService } from './company-line-channel.service.js';
import { LineEventHandlerService } from './line-event-handler.service.js';
import { WebhookEventStateService } from './webhook-event-state.service.js';

/**
 * BullMQ payload pushed by `LineWebhookService.persistAndEnqueue`. Kept slim:
 * we re-hydrate the full event from `WebhookEvent.payload` (RLS-scoped read)
 * inside the worker so retries always see the canonical row, never a stale
 * BullMQ-side snapshot.
 *
 * Why we don't ship the whole event in the job body:
 *   - Redis bytes cost — a single LINE batch can carry sticker payloads with
 *     mention objects, quote tokens, etc. We've already paid the storage cost
 *     in Postgres; no need to duplicate.
 *   - Single source of truth — if we ever back-patch a payload after the
 *     fact (PII redaction, schema evolution), the worker reads the corrected
 *     copy.
 */
export type LineEventJobData = {
  webhookEventRowId: string;
  companyId: string;
  channelId: string;
  eventId: string;
  eventType: string;
};

/**
 * In-process BullMQ worker for the `line-webhook` queue.
 *
 * Responsibilities:
 *
 *   process(job)                     ─►  hydrate row → resolve channel →
 *                                        dispatch → mark processed
 *
 *   @OnWorkerEvent('failed')         ─►  record terminal failure when BullMQ
 *                                        has exhausted all attempts (NOT on
 *                                        each transient failure)
 *
 * Hydration vs Job-body trade-off — see `LineEventJobData` JSDoc above.
 *
 * Per-job RLS scope — every Prisma read for hydration is wrapped in
 * `withTenant({ companyId })` because `WebhookEvent` is an RLS-scoped table.
 * Skipping this would either return zero rows (because the bypass policy isn't
 * set) or — worse — succeed by accident on a misconfigured DB.
 *
 * Channel resolution path uses the BYPASS-RLS lookup (slug-based or
 * companyId-based — channel rows are RLS-scoped; the worker doesn't have a
 * "request user" to derive the scope from). Same pattern as the controller.
 *
 * Failure-tracking pattern:
 *   We DON'T mark `failed` per attempt — only after BullMQ has burned all
 *   `attempts: 5`. Detected by comparing `job.attemptsMade` to
 *   `job.opts.attempts`. Per-attempt failures stay in BullMQ's own
 *   bookkeeping (visible in BullBoard); the DB row stays `pending` so the
 *   reconcile sweep (Phase 2) can re-enqueue stuck rows.
 */
@Processor(QUEUE_NAMES.LINE_WEBHOOK)
export class LineEventProcessor extends WorkerHost {
  private readonly logger = new Logger(LineEventProcessor.name);

  constructor(
    private readonly handler: LineEventHandlerService,
    private readonly channelService: CompanyLineChannelService,
    private readonly state: WebhookEventStateService,
  ) {
    super();
  }

  /**
   * Worker entry. Throws are caught by BullMQ which retries per the queue's
   * configured backoff (5 attempts, exponential 1s base — set in
   * `LineWebhookService.persistAndEnqueue`).
   *
   * Returns `{ ok: true }` on success — useful in BullBoard, not consumed
   * elsewhere.
   */
  async process(job: Job<LineEventJobData>): Promise<{ ok: true }> {
    const { webhookEventRowId, companyId, channelId, eventId } = job.data;

    // 1. Hydrate the WebhookEvent row + parse its payload back into a
    //    typed event. RLS-scoped read — explicit `withTenant({ companyId })`
    //    because the worker has no request-level interceptor.
    const row = await withTenant({ companyId }, async () => {
      return prisma.webhookEvent.findUnique({
        where: { id: webhookEventRowId },
        select: { payload: true, status: true },
      });
    });

    if (!row) {
      // Either the row was deleted (admin GDPR purge) or never existed
      // (impossible — controller commits before enqueue). Either way:
      // nothing to process. Return cleanly so BullMQ marks the job done.
      this.logger.warn(
        `LINE event row missing rowId=${webhookEventRowId} company=${companyId} eventId=${eventId} — likely purged; skipping`,
      );
      return { ok: true };
    }

    if (row.status === 'processed') {
      // BullMQ-level dedup (`jobId: ${companyId}:${eventId}`) usually catches
      // re-enqueues, but a manual reconcile sweep could re-fire. Idempotent.
      this.logger.debug(
        `LINE event already processed rowId=${webhookEventRowId} eventId=${eventId} — skipping handler`,
      );
      return { ok: true };
    }

    // 2. Re-validate the persisted JSON against our shared schema. The
    //    controller already validated on the way in, but a forward-compat
    //    schema change between enqueue and processing could surface here.
    let event: LineWebhookEvent;
    try {
      const parsed: unknown = row.payload;
      event = lineWebhookEventSchema.parse(parsed);
    } catch (err) {
      // Permanent failure — no point retrying a parse error. Throw so the
      // failed-listener marks it terminal on the FIRST attempt.
      throw new PermanentJobError(
        `LINE event payload failed Zod validation rowId=${webhookEventRowId}: ${(err as Error).message}`,
      );
    }

    // 3. Resolve the per-tenant channel (decrypted secrets) — same lookup
    //    the controller used. Bypasses RLS because channel rows are
    //    RLS-scoped on companyId and we don't have a tenant context yet
    //    at this layer. Cached at the channelService level (not yet, but
    //    a future memoization wouldn't change call shape).
    const channel = await this.channelService.findByCompanyIdUnscoped(companyId);
    if (!channel) {
      // The channel was deleted between enqueue and dispatch (admin
      // disabled the OA, or a tenant churn job ran). Treat as permanent
      // — nothing useful to do.
      throw new PermanentJobError(
        `LINE channel disappeared for company=${companyId} (rowId=${webhookEventRowId}, channelId=${channelId})`,
      );
    }

    // 4. Dispatch. Handler may throw transient errors → BullMQ retries.
    await this.handler.handle({ event, channel });

    // 5. Mark the row processed (RLS-scoped write). Failures HERE leak the
    //    job back into a retry which would re-run the handler (idempotent
    //    on our side because LINE reply tokens are single-use, but cleaner
    //    to log + swallow so we don't burn a reply attempt twice). We let
    //    it throw — markProcessed itself opens a tx, retry is OK.
    await this.state.markProcessed({ webhookEventRowId, companyId });

    return { ok: true };
  }

  /**
   * Terminal failure listener — fires on EVERY attempt, including transient.
   * We only persist to `WebhookEvent` when ALL attempts are exhausted, so
   * pending → failed is a single row update at the end, not retry churn.
   *
   * `PermanentJobError` short-circuits to terminal regardless of attempt
   * count — used for "no point retrying" branches (Zod fail, channel gone).
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<LineEventJobData> | undefined, err: Error): Promise<void> {
    if (!job) {
      // Stalled job removed by `removeOnFail` policy. We have no rowId to
      // update — log so we can correlate against BullBoard if it recurs.
      this.logger.warn(
        `LINE event job arrived undefined in failed listener (stalled + removed): ${err.message}`,
      );
      return;
    }
    const isPermanent = err instanceof PermanentJobError;
    const attemptsMade = job.attemptsMade ?? 1;
    const maxAttempts = job.opts?.attempts ?? 1;
    const exhausted = attemptsMade >= maxAttempts;

    if (!isPermanent && !exhausted) {
      // Transient failure on a non-final attempt — BullMQ will retry. Just
      // log so we can see the build-up in ops.
      this.logger.warn(
        `LINE event attempt ${attemptsMade}/${maxAttempts} failed rowId=${job.data.webhookEventRowId} eventId=${job.data.eventId}: ${err.message}`,
      );
      return;
    }

    // Terminal — record on the row.
    this.logger.error(
      `LINE event TERMINAL failure rowId=${job.data.webhookEventRowId} eventId=${job.data.eventId} attempts=${attemptsMade}/${maxAttempts} permanent=${isPermanent}: ${err.message}`,
    );

    await this.state.markFailed({
      webhookEventRowId: job.data.webhookEventRowId,
      companyId: job.data.companyId,
      error: err,
      attemptsMade,
    });
  }
}

/**
 * Sentinel error — rethrown by `process()` to short-circuit retries when we
 * KNOW the job will never succeed (Zod parse failure, channel gone). The
 * `@OnWorkerEvent('failed')` listener checks `instanceof PermanentJobError`
 * and goes straight to terminal-failure bookkeeping.
 *
 * NOT exported from the module — internal contract only.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/**
 * Type guard helper for tests — ensures the type narrowing works without
 * leaking `instanceof` checks across files.
 */
export function isPermanentJobError(err: unknown): err is PermanentJobError {
  return err instanceof PermanentJobError;
}
