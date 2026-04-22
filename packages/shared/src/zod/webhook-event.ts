import { z } from 'zod';
import { companyIdSchema, uuidSchema } from './primitives.js';

/**
 * WebhookEvent — append-once log of inbound LINE deliveries.
 *
 * Powers two things:
 *   1. Postgres-only dedup at controller entry. The webhook handler runs
 *      `INSERT … ON CONFLICT (company_id, event_id) DO NOTHING` BEFORE
 *      enqueueing onto BullMQ. If the row already exists we ack 200 and
 *      skip — LINE retries are idempotent without a separate Redis SET.
 *   2. Worker audit trail + replay. The BullMQ processor flips
 *      `pending → processing → processed | failed` and stamps
 *      `processedAt` / `processingError`. Ops scripts can re-drive
 *      `failed` rows by resetting status (run under `bypassRls`).
 *
 * Field shape mirrors the Prisma model `WebhookEvent` 1:1.
 */
export const webhookEventStatusSchema = z.enum(['pending', 'processing', 'processed', 'failed']);
export type WebhookEventStatus = z.infer<typeof webhookEventStatusSchema>;

/**
 * Read-side view (DB row → API). `payload` is the raw LINE event JSON kept
 * verbatim so the worker can re-parse with the latest `webhook-line.ts`
 * schema even after schema changes.
 */
export const webhookEventSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  /** LINE-assigned event id (`webhookEventId`). Scoped unique with companyId. */
  eventId: z.string().min(1).max(64),
  /** LINE event type — `message`, `follow`, `unfollow`, `postback`, … */
  eventType: z.string().min(1).max(32),
  /** LINE channel id that received the delivery (matches CompanyLineChannel.channelId). */
  channelId: z.string().min(1).max(32),
  /** 1:1 chat user id — NULL for group/room sources. */
  lineUserId: z.string().min(1).max(64).nullable(),
  /** Raw event JSON — kept verbatim for replay + forward-compat. */
  payload: z.unknown(),
  /** Event timestamp from LINE (ms-epoch converted to Date). */
  eventTimestamp: z.date(),
  receivedAt: z.date(),
  status: webhookEventStatusSchema,
  processedAt: z.date().nullable(),
  processingError: z.string().max(1024).nullable(),
  retryCount: z.number().int().min(0).max(32767),
});
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

/**
 * Insert-side input — what the webhook controller writes.
 * `status`, `receivedAt`, `processedAt`, `processingError`, `retryCount`
 * default at the DB level so callers don't pass them.
 */
export const createWebhookEventInputSchema = z.object({
  eventId: z.string().min(1).max(64),
  eventType: z.string().min(1).max(32),
  channelId: z.string().min(1).max(32),
  lineUserId: z.string().min(1).max(64).nullable(),
  payload: z.unknown(),
  eventTimestamp: z.date(),
});
export type CreateWebhookEventInput = z.infer<typeof createWebhookEventInputSchema>;
