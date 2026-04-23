import { type Prisma, prisma, withTenant } from '@dorm/db';
import {
  LINE_SIGNATURE_HEADER,
  type LineWebhookEvent,
  type LineWebhookPayload,
  lineWebhookPayloadSchema,
} from '@dorm/shared/zod';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../../common/queue/queue-names.js';
import { CompanyLineChannelService } from './company-line-channel.service.js';
import { verifyLineSignature } from './line-signature.util.js';

/**
 * LINE Messaging API webhook orchestration.
 *
 * Per CLAUDE.md §3.10 + §3.11 the webhook MUST:
 *   1. Verify `X-Line-Signature` HMAC-SHA256 over the RAW body using the
 *      per-tenant channel secret BEFORE doing any work.
 *   2. Be idempotent on `webhookEventId` — LINE retries on its side and we
 *      cannot replay business logic for the same event.
 *
 * Flow per request:
 *
 *   POST /line/webhook/:companySlug
 *      │
 *      ├─ resolveChannel(slug)          ← bypass-RLS slug→companyId+channel
 *      ├─ verifyLineSignature(rawBody)  ← reject 401 on tampering
 *      ├─ Zod-validate JSON body        ← 400 on shape mismatch
 *      └─ for each event:
 *            ├─ withTenant({companyId})    ← RLS-scoped per-event tx
 *            │     ├─ findFirst dedup
 *            │     └─ INSERT WebhookEvent (status=pending)
 *            └─ enqueue job to BullMQ      ← AFTER tx commits
 *
 * We open a fresh `withTenant` per event (NOT one big tx around the whole
 * batch) because:
 *   - LINE batches up to 100 events in one POST. Holding a single Postgres tx
 *     open for the whole batch would block the connection pool.
 *   - Per-event isolation means a single duplicate or malformed event aborts
 *     only its own tx, leaving the rest of the batch processable.
 *   - The OUTER controller has no `req.user` (Public route), so the global
 *     `TenantContextInterceptor` is a no-op here — explicit `withTenant` is
 *     mandatory for any RLS-scoped write.
 *
 * Enqueue happens AFTER the dedup INSERT commits — if BullMQ enqueue fails,
 * the WebhookEvent row stays `pending` and a future scanner / Task #40
 * worker reconciliation can re-enqueue. Better to log + ack 200 than to
 * 500 LINE (LINE will keep retrying for 24h).
 *
 * Events whose `webhookEventId` is missing (very old LINE webhooks) get a
 * synthetic id derived from `(timestamp, type, source)` so dedup still
 * holds. We log a warning so we notice if this branch ever fires in prod.
 */
@Injectable()
export class LineWebhookService {
  private readonly logger = new Logger(LineWebhookService.name);

  constructor(
    private readonly channelService: CompanyLineChannelService,
    @InjectQueue(QUEUE_NAMES.LINE_WEBHOOK) private readonly queue: Queue,
  ) {}

  /**
   * Top-level entry — called by the controller. All security checks live
   * here so the controller stays a thin transport layer.
   */
  async handleWebhook(args: {
    companySlug: string;
    rawBody: Buffer;
    signatureHeader: string | string[] | undefined;
  }): Promise<{ ok: true; processed: number; deduped: number }> {
    const { companySlug, rawBody, signatureHeader } = args;

    // 1. Resolve the per-tenant channel under bypass-RLS (slug is public).
    //    Returns null when the slug is unknown OR the company is not active
    //    OR no channel is configured. We respond 404 in all three cases —
    //    LINE's webhook validator treats 404 as "this URL is not yours" so
    //    misconfigured channels don't silently succeed.
    const channel = await this.channelService.findByCompanySlugUnscoped(companySlug);
    if (!channel) {
      throw new NotFoundException({
        error: 'LineChannelNotConfigured',
        message: `No active LINE channel found for company '${companySlug}'`,
      });
    }

    // 2. HMAC verify against the RAW body. We MUST NOT JSON.parse before
    //    this step — re-stringifying loses byte fidelity.
    const ok = verifyLineSignature({
      rawBody,
      signatureHeader,
      channelSecret: channel.channelSecret,
    });
    if (!ok) {
      // Use 401 (not 403) per LINE's spec recommendation — signals to LINE
      // that the request was rejected by signature validation. Body intentionally
      // generic — no leaking which step failed (header-missing vs digest-mismatch).
      throw new UnauthorizedException({
        error: 'InvalidLineSignature',
        message: `${LINE_SIGNATURE_HEADER} verification failed`,
      });
    }

    // 3. Parse + validate body shape. Empty events[] is valid (LINE's
    //    "Verify" button hits us with `{ destination, events: [] }`).
    let payload: LineWebhookPayload;
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      payload = lineWebhookPayloadSchema.parse(parsed);
    } catch (err) {
      throw new BadRequestException({
        error: 'InvalidWebhookBody',
        message: `LINE webhook body failed validation: ${(err as Error).message}`,
      });
    }

    // 4. Per-event dedup + enqueue. We track aggregate counts for the
    //    response — useful in unit tests + ops dashboards.
    let processed = 0;
    let deduped = 0;
    for (const event of payload.events) {
      const result = await this.persistAndEnqueue({
        event,
        companyId: channel.companyId,
        channelId: channel.channelId,
      });
      if (result === 'enqueued') processed += 1;
      else deduped += 1;
    }

    return { ok: true, processed, deduped };
  }

  /**
   * Per-event persistence: dedup INSERT into `WebhookEvent`, then enqueue
   * the job. Returns `'duplicate'` when the event was already recorded
   * (LINE redelivery) so the controller can include it in the metric.
   */
  private async persistAndEnqueue(args: {
    event: LineWebhookEvent;
    companyId: string;
    channelId: string;
  }): Promise<'enqueued' | 'duplicate'> {
    const { event, companyId, channelId } = args;
    const eventId = event.webhookEventId ?? syntheticEventId(event);

    // Open per-event RLS-scoped tx. The dedup unique index is
    // `(companyId, eventId)` — RLS additionally walls off cross-tenant
    // reads/writes (defence-in-depth on top of the slug→channel lookup).
    const insertResult = await withTenant({ companyId }, async () => {
      // Pre-check is a "fast happy path" for LINE redeliveries: when LINE
      // re-fires within seconds, the row already exists and we skip the
      // INSERT (which would otherwise abort the tx with P2002).
      const existing = await prisma.webhookEvent.findFirst({
        where: { eventId },
        select: { id: true },
      });
      if (existing) return { kind: 'duplicate' as const };

      try {
        const row = await prisma.webhookEvent.create({
          data: {
            companyId,
            eventId,
            eventType: event.type,
            channelId,
            lineUserId: extractLineUserId(event),
            payload: event as unknown as Prisma.InputJsonValue,
            eventTimestamp: new Date(event.timestamp),
            status: 'pending',
          },
          select: { id: true },
        });
        return { kind: 'inserted' as const, webhookEventRowId: row.id };
      } catch (err) {
        // Rare race: a concurrent redelivery beat us to the INSERT between
        // the findFirst and create. P2002 on `(companyId, eventId)` means
        // "already recorded" — treat as duplicate. Anything else rethrows
        // and surfaces a 500 to LINE (which will retry — desired).
        if (isWebhookEventDuplicate(err)) return { kind: 'duplicate' as const };
        throw err;
      }
    });

    if (insertResult.kind === 'duplicate') {
      return 'duplicate';
    }

    // Enqueue OUTSIDE the tx — the row is committed; if BullMQ is briefly
    // unavailable the WebhookEvent stays `pending` and Task #40's reconcile
    // sweep will re-enqueue. We log + swallow so LINE still gets 200.
    try {
      await this.queue.add(
        'line-webhook-event',
        {
          webhookEventRowId: insertResult.webhookEventRowId,
          companyId,
          channelId,
          eventId,
          eventType: event.type,
        },
        {
          jobId: `${companyId}:${eventId}`, // BullMQ-level dedup key — second-line defence
          // Override module default — LINE retries on its end too, but we
          // want our worker to keep trying for transient downstream failures
          // (Tenant lookup, reply token expiry tolerance). 5 attempts, exp 1s base.
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
        },
      );
      return 'enqueued';
    } catch (err) {
      this.logger.error(
        `Failed to enqueue webhook event ${eventId} for company ${companyId}: ${(err as Error).message}. Row stays 'pending' for reconcile.`,
      );
      // Counted as enqueued from the dedup standpoint — the row exists +
      // worker reconcile will pick it up. Returning 'enqueued' keeps the
      // response metric honest about "newly persisted vs deduped".
      return 'enqueued';
    }
  }
}

/**
 * Older LINE webhook deliveries (pre-2020) sometimes lacked `webhookEventId`.
 * Falls back to a stable hash of the fields most likely to differ between
 * unique events. NOT cryptographic — just collision-resistant within a
 * tenant's webhook stream.
 */
function syntheticEventId(event: LineWebhookEvent): string {
  // Source carries either userId / groupId / roomId. Stringify defensively.
  const sourceKey = event.source ? JSON.stringify(event.source) : 'no-source';
  // Truncate to fit the VarChar(64) column. djb2-style mixing for low collision rate.
  const raw = `${event.timestamp}:${event.type}:${sourceKey}`;
  let hash = 5381;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 33) ^ raw.charCodeAt(i);
  }
  return `synth-${(hash >>> 0).toString(16)}-${event.timestamp}`;
}

/**
 * Pull the LINE userId for the index column. NULL when the event source has
 * no associated user (e.g. group `memberLeft` events).
 */
function extractLineUserId(event: LineWebhookEvent): string | null {
  if (!event.source || typeof event.source !== 'object') return null;
  const src = event.source as { userId?: unknown };
  return typeof src.userId === 'string' ? src.userId : null;
}

/**
 * Detect Prisma P2002 on the `webhook_event_company_event_unique` index.
 * Permissive on opaque target metadata — the only non-id unique constraint
 * on the table is the dedup tuple, so any P2002 here is a duplicate.
 */
function isWebhookEventDuplicate(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string };
  return e.code === 'P2002';
}
