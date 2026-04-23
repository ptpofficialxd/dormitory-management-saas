import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { Public } from '../../common/decorators/public.decorator.js';
import { PrismaHealthIndicator } from './indicators/prisma.health.js';
import { RedisHealthIndicator } from './indicators/redis.health.js';

/**
 * Health endpoints split per Kubernetes / load-balancer convention:
 *
 *   GET /health        → LIVENESS  — process is up. Never touches deps so a
 *                        slow DB never restart-loops the API. LBs and docker
 *                        healthcheck use this.
 *
 *   GET /health/ready  → READINESS — process AND its dependencies (Postgres,
 *                        Redis) are usable. Used by orchestrator gates +
 *                        Task #38 ops checks. Returns 503 if any indicator
 *                        fails.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly redisIndicator: RedisHealthIndicator,
  ) {}

  @Get()
  @Public()
  ping(): { status: 'ok'; ts: string } {
    return { status: 'ok', ts: new Date().toISOString() };
  }

  @Get('ready')
  @Public()
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.prismaIndicator.pingCheck('database'),
      () => this.redisIndicator.pingCheck('redis'),
    ]);
  }
}
