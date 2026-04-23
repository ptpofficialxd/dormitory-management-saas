import { URL } from 'node:url';
import type { ConnectionOptions } from 'bullmq';
import type { RedisOptions } from 'ioredis';

/**
 * Parse `REDIS_URL` into ioredis-compatible options.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on its connection — otherwise
 * blocking commands (`BRPOPLPUSH`) error out under load. We also set
 * `enableReadyCheck: false` so Redis Cluster failover doesn't hang the worker
 * (BullMQ docs §"Connection options").
 *
 * `lazyConnect: true` lets us defer the TCP handshake until the first command,
 * which keeps NestJS boot fast and avoids a noisy crash if Redis is briefly
 * unavailable during deploy windows.
 */
export function parseRedisOptions(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(`Invalid REDIS_URL protocol: ${url.protocol}. Expected redis: or rediss:.`);
  }

  const port = url.port ? Number.parseInt(url.port, 10) : 6379;
  // `pathname` for redis URLs is `/<dbIndex>`; strip the leading slash.
  const dbStr = url.pathname.replace(/^\//, '');
  const db = dbStr ? Number.parseInt(dbStr, 10) : 0;
  if (Number.isNaN(db)) {
    throw new Error(`Invalid REDIS_URL db index: ${dbStr}`);
  }

  return {
    host: url.hostname,
    port,
    db,
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    // BullMQ-required:
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Lazy: defer connection until first command.
    lazyConnect: true,
  };
}

/**
 * Build the BullMQ `ConnectionOptions` from a parsed Redis URL.
 * BullMQ accepts a subset of ioredis options under the same keys.
 */
export function buildBullConnection(redisUrl: string): ConnectionOptions {
  return parseRedisOptions(redisUrl);
}
