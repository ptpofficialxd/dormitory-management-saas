import { prisma, withTenant } from '@dorm/db';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Owns the lifecycle transitions on the `WebhookEvent` row created by the
 * webhook controller. Worker calls into here to record terminal state.
 *
 * Why a dedicated service:
 *   - All writes MUST be RLS-scoped (`WebhookEvent` has a row-level policy
 *     on `companyId`), so we centralise the `withTenant({ companyId })`
 *     wrapping in one place.
 *   - The dispatcher should not know about Prisma — it just shouts
 *     "this event is done" / "this event is dead" and we own the SQL.
 *   - Keeping it small means the worker's @Processor stays a thin shim.
 *
 * Status transitions:
 *
 *   pending  ──► processed       (handler ran cleanly)
 *   pending  ──► failed          (terminal failure — exhausted attempts)
 *
 * `processing` is intentionally NOT used in MVP — BullMQ tracks "in-flight"
 * separately, and we'd rather double-write than carry a half-state in two
 * places. Phase 2 may revisit if we add a long-running step.
 *
 * Errors written to `processingError` are TRUNCATED to fit `VarChar(1024)`.
 * Stack traces blow past that fast — we keep the first line + the first KB
 * of the message which is plenty to triage in pgAdmin.
 */

const PROCESSING_ERROR_MAX_CHARS = 1024 as const;

@Injectable()
export class WebhookEventStateService {
  private readonly logger = new Logger(WebhookEventStateService.name);

  /**
   * Mark the row as `processed` + stamp `processedAt = now()`. Idempotent at
   * the DB level — re-running this on an already-processed row just refreshes
   * the timestamp (no harm; BullMQ's job-id dedup makes this rare anyway).
   *
   * Returns nothing — this is fire-and-forget from the worker's POV.
   */
  async markProcessed(args: { webhookEventRowId: string; companyId: string }): Promise<void> {
    const { webhookEventRowId, companyId } = args;
    await withTenant({ companyId }, async () => {
      await prisma.webhookEvent.update({
        where: { id: webhookEventRowId },
        data: {
          status: 'processed',
          processedAt: new Date(),
        },
      });
    });
  }

  /**
   * Terminal failure — increments `retryCount` snapshot, stamps
   * `processedAt` (yes, even on failure — it's the "we stopped trying" time),
   * stores the truncated error message, sets `status='failed'`.
   *
   * Called from the BullMQ `@OnWorkerEvent('failed')` listener AFTER the job
   * has exhausted all attempts. NOT called per attempt — only on the last.
   */
  async markFailed(args: {
    webhookEventRowId: string;
    companyId: string;
    error: unknown;
    attemptsMade: number;
  }): Promise<void> {
    const { webhookEventRowId, companyId, error, attemptsMade } = args;
    const message = truncateError(error);

    try {
      await withTenant({ companyId }, async () => {
        await prisma.webhookEvent.update({
          where: { id: webhookEventRowId },
          data: {
            status: 'failed',
            processedAt: new Date(),
            processingError: message,
            retryCount: attemptsMade,
          },
        });
      });
    } catch (err) {
      // We're already in the worker's failure handler — if THIS write also
      // fails (DB outage etc.) we MUST NOT throw further or BullMQ will
      // re-fire the failed listener and we'll loop. Log loud + swallow.
      this.logger.error(
        `Failed to mark webhook event ${webhookEventRowId} (company=${companyId}) as failed: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Coerce arbitrary `unknown` into a printable string capped at the column
 * width. Strips ANSI color codes (Prisma sometimes emits them in dev) so
 * a `\x1b[...]` sequence doesn't burn 8 of our 1024 chars.
 */
function truncateError(err: unknown): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message;
  } else if (typeof err === 'string') {
    raw = err;
  } else {
    try {
      raw = JSON.stringify(err);
    } catch {
      raw = String(err);
    }
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences contain ESC (0x1B)
  const cleaned = raw.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
  return cleaned.length <= PROCESSING_ERROR_MAX_CHARS
    ? cleaned
    : `${cleaned.slice(0, PROCESSING_ERROR_MAX_CHARS - 1)}…`;
}
