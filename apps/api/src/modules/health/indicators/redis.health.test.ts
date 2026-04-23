import { HealthCheckError } from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { RedisHealthIndicator } from './redis.health.js';

/**
 * Build a minimal `Redis` stub with just the surface the indicator touches.
 * `as unknown as Redis` cast is fine here — we control all method calls.
 */
function makeRedis(pingImpl: () => Promise<string>): Redis {
  return { ping: pingImpl } as unknown as Redis;
}

describe('RedisHealthIndicator', () => {
  it('returns up when PING responds with PONG', async () => {
    const indicator = new RedisHealthIndicator(makeRedis(async () => 'PONG'));
    const result = await indicator.pingCheck('redis');
    expect(result).toEqual({ redis: { status: 'up', response: 'PONG' } });
  });

  it('throws HealthCheckError when PING returns a non-PONG value', async () => {
    const indicator = new RedisHealthIndicator(makeRedis(async () => 'WAT'));
    await expect(indicator.pingCheck('redis')).rejects.toBeInstanceOf(HealthCheckError);
  });

  it('throws HealthCheckError when PING rejects', async () => {
    const indicator = new RedisHealthIndicator(
      makeRedis(async () => {
        throw new Error('connection refused');
      }),
    );
    await expect(indicator.pingCheck('redis')).rejects.toBeInstanceOf(HealthCheckError);
  });

  it('honours custom indicator key in result envelope', async () => {
    const indicator = new RedisHealthIndicator(makeRedis(async () => 'PONG'));
    const result = await indicator.pingCheck('cache');
    expect(result).toHaveProperty('cache');
    expect(result.cache).toMatchObject({ status: 'up' });
  });

  it('times out after 1s when PING hangs', async () => {
    vi.useFakeTimers();
    try {
      const indicator = new RedisHealthIndicator(
        makeRedis(() => new Promise(() => {})), // never resolves
      );
      const promise = indicator.pingCheck('redis');
      vi.advanceTimersByTime(1100);
      await expect(promise).rejects.toBeInstanceOf(HealthCheckError);
    } finally {
      vi.useRealTimers();
    }
  });
});
