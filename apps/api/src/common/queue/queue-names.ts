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
  /** Outbound LINE broadcasts (announcements, billing notices). Phase 1. */
  LINE_BROADCAST: 'line-broadcast',
  /** Background billing jobs (monthly invoice batch, late-fee accrual). */
  BILLING: 'billing',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Iteration helper for module registration / health checks. */
export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.freeze(Object.values(QUEUE_NAMES));
