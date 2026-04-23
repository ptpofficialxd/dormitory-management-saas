import { BullModule } from '@nestjs/bullmq';
import { Global, Logger, Module } from '@nestjs/common';
import type { JobsOptions } from 'bullmq';
import { env } from '../../config/env.js';
import { ALL_QUEUE_NAMES } from './queue-names.js';
import { REDIS_CLIENT, REDIS_CLIENT_PROVIDER, RedisClientHolder } from './redis-client.provider.js';
import { buildBullConnection } from './redis-connection.js';

/**
 * Default job options applied to every queue at the module level. Per-job
 * overrides still win (e.g. webhook events bump `attempts` to 5 because LINE
 * may retry on its side anyway, see Task #39).
 *
 * - `attempts: 3` + exponential backoff (1s → 2s → 4s) covers transient
 *   network blips without hammering downstream services.
 * - `removeOnComplete: 100` keeps the last 100 successful jobs for ops
 *   visibility but bounds memory.
 * - `removeOnFail: 500` keeps a longer tail of failures so we can inspect
 *   them in BullBoard / via CLI.
 */
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
};

/**
 * Global QueueModule — one bootstrap point for every queue + worker the API
 * touches.
 *
 * In-process worker model per Task #38 decision: producers and consumers
 * share the same NestJS lifecycle, which keeps deploys to a single container
 * until traffic forces us to split (CLAUDE.md §8 — no premature abstraction).
 *
 * Why `@Global()`:
 *   feature modules inject `@InjectQueue('line-webhook')` without re-importing
 *   QueueModule. Mirrors how the @nestjs/bullmq docs recommend wiring root.
 */
@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: buildBullConnection(env.REDIS_URL),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
    BullModule.registerQueue(...ALL_QUEUE_NAMES.map((name) => ({ name }))),
  ],
  providers: [RedisClientHolder, REDIS_CLIENT_PROVIDER],
  // Export the token (Symbol), not the provider object — Nest resolves
  // exports by DI token, not by provider definition reference.
  exports: [BullModule, REDIS_CLIENT],
})
export class QueueModule {
  private static readonly logger = new Logger(QueueModule.name);

  constructor() {
    QueueModule.logger.log(`QueueModule initialised with queues: ${ALL_QUEUE_NAMES.join(', ')}`);
  }
}
