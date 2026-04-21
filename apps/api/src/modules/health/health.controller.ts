import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';

/**
 * Liveness check. Always returns 200 without touching the DB so load
 * balancers / docker healthcheck stay fast.
 *
 * Separate readiness probe (which pings Postgres + Redis) will come with
 * ops hardening in Phase 2 — MVP doesn't need it.
 */
@Controller('health')
export class HealthController {
  @Get()
  @Public()
  ping(): { status: 'ok'; ts: string } {
    return { status: 'ok', ts: new Date().toISOString() };
  }
}
