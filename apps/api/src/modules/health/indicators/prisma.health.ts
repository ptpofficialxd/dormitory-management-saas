import { rawPrisma } from '@dorm/db';
import { Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';

/**
 * Terminus indicator that pings Postgres with `SELECT 1` and a hard 1s
 * timeout.
 *
 * Uses `rawPrisma` (the un-proxied client) directly — `SELECT 1` doesn't
 * touch any RLS-protected table, so we don't need a tenant context, and
 * skipping the ALS proxy avoids spurious "outside tenant context" failures
 * if the indicator is invoked from a non-request scope (cron, worker boot).
 */
@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  async pingCheck(key = 'database'): Promise<HealthIndicatorResult> {
    try {
      await Promise.race([
        rawPrisma.$queryRaw`SELECT 1`,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('postgres ping timeout (1000ms)')), 1000),
        ),
      ]);
      return this.getStatus(key, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HealthCheckError('Postgres check failed', this.getStatus(key, false, { message }));
    }
  }
}
