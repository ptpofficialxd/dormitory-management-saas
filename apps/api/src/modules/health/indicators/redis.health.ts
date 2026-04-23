import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import { InjectRedis } from '../../../common/queue/redis-client.provider.js';

/**
 * Terminus indicator that PINGs Redis with a hard 1s timeout.
 *
 * `Redis#ping()` resolves with the literal string 'PONG'; anything else means
 * the connection is degraded (proxy interception, half-open socket). We
 * surface it as `HealthCheckError` so /health/ready returns 503.
 */
@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@InjectRedis() private readonly redis: Redis) {
    super();
  }

  async pingCheck(key = 'redis'): Promise<HealthIndicatorResult> {
    try {
      const result = await Promise.race([
        this.redis.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('redis ping timeout (1000ms)')), 1000),
        ),
      ]);
      const ok = result === 'PONG';
      const indicator = this.getStatus(key, ok, { response: result });
      if (!ok) {
        throw new HealthCheckError('Redis check failed', indicator);
      }
      return indicator;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HealthCheckError('Redis check failed', this.getStatus(key, false, { message }));
    }
  }
}
