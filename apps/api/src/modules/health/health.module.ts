import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';
import { PrismaHealthIndicator } from './indicators/prisma.health.js';
import { RedisHealthIndicator } from './indicators/redis.health.js';

/**
 * Health endpoints module.
 *
 * - Liveness: `GET /health` (no dep touch) — see HealthController.
 * - Readiness: `GET /health/ready` (Postgres + Redis) — uses Terminus.
 *
 * `RedisHealthIndicator` resolves `REDIS_CLIENT` from the global QueueModule
 * (registered in app.module.ts), so HealthModule does NOT need to import
 * QueueModule — DI handles the wiring via `@Global()`.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [PrismaHealthIndicator, RedisHealthIndicator],
})
export class HealthModule {}
