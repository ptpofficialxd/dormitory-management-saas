import { z } from 'zod';

/**
 * LINE Messaging API webhook payload — inbound events pushed by LINE to
 * our `POST /webhook/line` endpoint.
 *
 * The endpoint MUST verify `X-Line-Signature` (HMAC-SHA256 over the raw
 * body using the per-tenant channel secret) BEFORE parsing (CLAUDE.md
 * §3.11). Fastify's raw body is captured for that purpose — this Zod
 * schema validates the body AFTER signature passes.
 *
 * Why every event is `.passthrough()` + unknown-tolerant:
 *   LINE ships new event types + new fields without notice (sticker
 *   payloads, quote tokens, mention objects, etc.). Strict schemas
 *   would start rejecting valid production webhooks. We parse only the
 *   fields we use and forward the rest untouched.
 *
 * MVP scope — we handle:
 *   - `message` (type = `text`) — tenant chat + command parsing
 *   - `follow` — store consent + bootstrap tenant record
 *   - `unfollow` — flag tenant as opted-out (do NOT delete)
 *   - `postback` — rich menu / quick reply actions
 *
 * Other event types (`beacon`, `accountLink`, `memberJoined`, …) pass
 * through as `unknownEvent` so the handler can ack-and-ignore without
 * blowing up signature-valid deliveries.
 */

// -------------------------------------------------------------------------
// Shared sub-schemas
// -------------------------------------------------------------------------

/** Common fields every webhook event carries. LINE's epoch is **milliseconds**. */
const eventBaseSchema = z.object({
  type: z.string().min(1),
  /** Millisecond UNIX epoch. */
  timestamp: z.number().int().nonnegative(),
  /** De-dupe key across redeliveries. Missing on very old webhooks — optional. */
  webhookEventId: z.string().min(1).max(128).optional(),
  /** `{ isRedelivery: boolean }` — added in v2+; optional for back-compat. */
  deliveryContext: z.object({ isRedelivery: z.boolean() }).optional(),
});

/**
 * `source` varies by chat kind. We care about the `userId` on 1:1 chats
 * (which is how we correlate LINE user → Tenant record); for group/room
 * events we still capture the id but skip message-reply logic.
 */
const sourceUserSchema = z
  .object({
    type: z.literal('user'),
    userId: z.string().min(1).max(64),
  })
  .passthrough();

const sourceGroupSchema = z
  .object({
    type: z.literal('group'),
    groupId: z.string().min(1).max(64),
    userId: z.string().min(1).max(64).optional(),
  })
  .passthrough();

const sourceRoomSchema = z
  .object({
    type: z.literal('room'),
    roomId: z.string().min(1).max(64),
    userId: z.string().min(1).max(64).optional(),
  })
  .passthrough();

export const lineEventSourceSchema = z.discriminatedUnion('type', [
  sourceUserSchema,
  sourceGroupSchema,
  sourceRoomSchema,
]);
export type LineEventSource = z.infer<typeof lineEventSourceSchema>;

// -------------------------------------------------------------------------
// Message event (MVP: text only, others pass through as `unknownMessage`)
// -------------------------------------------------------------------------

const textMessageSchema = z
  .object({
    type: z.literal('text'),
    id: z.string().min(1).max(64),
    /** LINE caps text at 5 000 chars — we accept up to that. */
    text: z.string().min(1).max(5000),
  })
  .passthrough();

const imageMessageSchema = z
  .object({
    type: z.literal('image'),
    id: z.string().min(1).max(64),
  })
  .passthrough();

const stickerMessageSchema = z
  .object({
    type: z.literal('sticker'),
    id: z.string().min(1).max(64),
    packageId: z.string().optional(),
    stickerId: z.string().optional(),
  })
  .passthrough();

/**
 * Fallback for message kinds we don't special-case yet (video, audio,
 * location, file). Preserves the `type` + `id` so logs are useful.
 */
const unknownMessageSchema = z
  .object({
    type: z.string().min(1),
    id: z.string().min(1).max(64),
  })
  .passthrough();

/** A message event's `message` property — pick the known kinds first. */
export const lineMessageContentSchema = z.union([
  textMessageSchema,
  imageMessageSchema,
  stickerMessageSchema,
  unknownMessageSchema,
]);
export type LineMessageContent = z.infer<typeof lineMessageContentSchema>;

const messageEventSchema = eventBaseSchema
  .extend({
    type: z.literal('message'),
    source: lineEventSourceSchema,
    /** Short-lived — use to reply within 1 request-window; NULL in redelivered events. */
    replyToken: z.string().min(1).max(128).optional(),
    message: lineMessageContentSchema,
  })
  .passthrough();
export type LineMessageEvent = z.infer<typeof messageEventSchema>;

// -------------------------------------------------------------------------
// Follow / Unfollow / Postback
// -------------------------------------------------------------------------

const followEventSchema = eventBaseSchema
  .extend({
    type: z.literal('follow'),
    source: lineEventSourceSchema,
    replyToken: z.string().min(1).max(128).optional(),
  })
  .passthrough();
export type LineFollowEvent = z.infer<typeof followEventSchema>;

const unfollowEventSchema = eventBaseSchema
  .extend({
    type: z.literal('unfollow'),
    source: lineEventSourceSchema,
  })
  .passthrough();
export type LineUnfollowEvent = z.infer<typeof unfollowEventSchema>;

const postbackEventSchema = eventBaseSchema
  .extend({
    type: z.literal('postback'),
    source: lineEventSourceSchema,
    replyToken: z.string().min(1).max(128).optional(),
    postback: z
      .object({
        /** Action `data` param from rich-menu / quick-reply — we encode commands here. */
        data: z.string().min(1).max(300),
        params: z.record(z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type LinePostbackEvent = z.infer<typeof postbackEventSchema>;

/**
 * Catch-all for events we receive but don't handle yet. Keeps `type` so
 * the webhook handler can log + ack, and preserves the rest via passthrough.
 * This MUST be the last branch in the union so discriminated types win.
 */
const unknownEventSchema = eventBaseSchema.passthrough();
export type LineUnknownEvent = z.infer<typeof unknownEventSchema>;

// -------------------------------------------------------------------------
// Top-level payload
// -------------------------------------------------------------------------

/**
 * One array element in `events[]`. `z.union` (not `discriminatedUnion`)
 * because `unknownEventSchema` uses the same `type` field space as the
 * named branches — Zod's discriminated union requires literals for all
 * branches, which we can't promise for forward-compat.
 */
export const lineWebhookEventSchema = z.union([
  messageEventSchema,
  followEventSchema,
  unfollowEventSchema,
  postbackEventSchema,
  unknownEventSchema,
]);
export type LineWebhookEvent = z.infer<typeof lineWebhookEventSchema>;

/**
 * Top-level body. LINE batches multiple events per POST — we MUST handle
 * partial failures (ack the whole batch, enqueue each event onto BullMQ).
 * An empty `events: []` is valid (health-check hit from LINE console).
 */
export const lineWebhookPayloadSchema = z.object({
  /** Channel ID that received the event — matches our per-tenant channel config. */
  destination: z.string().min(1).max(64),
  events: z.array(lineWebhookEventSchema).max(100),
});
export type LineWebhookPayload = z.infer<typeof lineWebhookPayloadSchema>;

/**
 * Header name LINE sends for the HMAC. Kept as a constant so the
 * signature-verification middleware + tests use one source of truth.
 */
export const LINE_SIGNATURE_HEADER = 'x-line-signature' as const;
