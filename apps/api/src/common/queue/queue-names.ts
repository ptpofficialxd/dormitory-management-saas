/**
 * Centralized BullMQ queue name registry.
 *
 * Naming convention: `<domain>-<noun>` lowercase-hyphen. Names are stored in
 * Redis as keys (`bull:<name>:*`), so renaming a queue is a breaking change
 * that orphans in-flight jobs — treat the values as immutable contracts.
 *
 * NEVER hard-code these strings in producers/consumers; always import from
 * here. This way Task #39 (webhook controller) and Task #40 (worker) reference
 * the same identifier and TypeScript will catch typos at compile time.
 */
export const QUEUE_NAMES = {
  /** LINE webhook events awaiting dispatch (one job per LINE event id). */
  LINE_WEBHOOK: 'line-webhook',
  /**
   * Transactional 1-to-1 LINE pushes — invoice issued, payment approved,
   * payment rejected. One job per (kind, tenantId, invoiceId) tuple, deduped
   * via explicit BullMQ jobId. Worker resolves tenant.lineUserId + the
   * per-company channel, renders the Thai template, calls
   * `LineMessagingClient.pushMessage`. Permanent errors (4xx — blocked OA,
   * unbound tenant) are absorbed; transient errors retry per default backoff.
   */
  LINE_NOTIFICATION: 'line-notification',
  /**
   * Outbound LINE broadcasts (admin announcements, multi-recipient pushes).
   * Distinct from `LINE_NOTIFICATION` because broadcasts use the multicast /
   * narrowcast endpoints with very different rate-limit + retry semantics.
   * Reserved for Phase 2 announcement composer.
   */
  LINE_BROADCAST: 'line-broadcast',
  /** Background billing jobs (monthly invoice batch, late-fee accrual). */
  BILLING: 'billing',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Iteration helper for module registration / health checks. */
export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.freeze(Object.values(QUEUE_NAMES));
