import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { parseRedisOptions } from './redis-connection.js';

/**
 * DI token for the shared raw ioredis client.
 *
 * Use this — never `new Redis(...)` ad-hoc — so health checks, cache layers,
 * and rate limiters share a single connection per process. Sockets are
 * expensive and BullMQ already keeps its own pool separately.
 */
export const REDIS_CLIENT = Symbol.for('REDIS_CLIENT');

/**
 * Thin wrapper around `Redis` that participates in Nest's lifecycle so the
 * connection is closed cleanly on shutdown (`app.enableShutdownHooks()`).
 *
 * Exposed under `REDIS_CLIENT` token; consumers receive the underlying
 * `Redis` instance via the static factory.
 */
@Injectable()
export class RedisClientHolder implements OnModuleDestroy {
  private readonly logger = new Logger(RedisClientHolder.name);
  readonly client: Redis;

  constructor() {
    this.client = new Redis(parseRedisOptions(env.REDIS_URL));
    this.client.on('error', (err) => {
      // Don't crash on transient errors — `/health/ready` surfaces state.
      this.logger.error(`Redis error: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    // `quit()` waits for in-flight commands to drain, unlike `disconnect()`.
    if (this.client.status !== 'end') {
      await this.client.quit();
    }
  }
}

/**
 * Provider definition that exposes the raw `Redis` instance under
 * `REDIS_CLIENT` while keeping `RedisClientHolder` as the lifecycle owner.
 */
export const REDIS_CLIENT_PROVIDER = {
  provide: REDIS_CLIENT,
  useFactory: (holder: RedisClientHolder): Redis => holder.client,
  inject: [RedisClientHolder],
};

/** Shorthand for `@Inject(REDIS_CLIENT)`. */
export const InjectRedis = (): ParameterDecorator => Inject(REDIS_CLIENT);
