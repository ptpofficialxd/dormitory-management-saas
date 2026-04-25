import { describe, expect, it } from 'vitest';
import { ALL_QUEUE_NAMES, QUEUE_NAMES } from './queue-names.js';

describe('QUEUE_NAMES', () => {
  it('exposes the MVP queues with stable string identifiers', () => {
    // These values are storage keys in Redis (`bull:<name>:*`); changing them
    // is a breaking change. This test guards against silent renames.
    // LINE_NOTIFICATION added in Task #83 — transactional 1-to-1 push queue.
    expect(QUEUE_NAMES).toEqual({
      LINE_WEBHOOK: 'line-webhook',
      LINE_NOTIFICATION: 'line-notification',
      LINE_BROADCAST: 'line-broadcast',
      BILLING: 'billing',
    });
  });

  it('names follow the lowercase-hyphen convention (no spaces, no upper)', () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('exposes all names via ALL_QUEUE_NAMES (frozen)', () => {
    expect(ALL_QUEUE_NAMES).toHaveLength(Object.keys(QUEUE_NAMES).length);
    expect(Object.isFrozen(ALL_QUEUE_NAMES)).toBe(true);
  });

  it('contains no duplicate names', () => {
    const set = new Set(ALL_QUEUE_NAMES);
    expect(set.size).toBe(ALL_QUEUE_NAMES.length);
  });
});
