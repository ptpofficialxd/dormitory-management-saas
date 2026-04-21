import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaClient, type Prisma } from '@prisma/client';

/**
 * Per-request tenant context. Set at the API/request boundary (NestJS guard
 * or middleware reads JWT → calls `withTenant(ctx, fn)`). The `prisma` proxy
 * (see `client.ts`) reads the active transaction from this module's ALS and
 * routes every query through it — so `SET LOCAL app.company_id` is visible
 * to the actual SQL, on the SAME pool connection.
 *
 * Why ALS + interactive tx (not Prisma `$extends`)?
 *   A `$extends` middleware's `query(args)` dispatches on the base client
 *   and may pick a DIFFERENT pool connection than the one where `SET LOCAL`
 *   was applied — defeating RLS silently. Storing `tx` in AsyncLocalStorage
 *   and routing through it guarantees same-connection execution.
 */

export type TenantContext = {
  /** Tenant UUID. Empty string or missing = no-tenant = RLS default-deny. */
  readonly companyId: string;
  /**
   * Skip RLS (sets `app.bypass_rls = true` in the tx).
   * Only used by seed scripts, platform super_admin tools, and migrations.
   * NEVER set this from a request handler.
   */
  readonly bypassRls?: boolean;
};

/** Internal store: user-facing context PLUS the live tx client. */
type Store = {
  readonly ctx: TenantContext;
  /**
   * The interactive-transaction client whose underlying connection has the
   * `SET LOCAL app.company_id` / `app.bypass_rls` values installed.
   */
  readonly tx: Prisma.TransactionClient;
};

const storage = new AsyncLocalStorage<Store>();

/**
 * Shared Prisma singleton. Scripts (seed, apply-rls, tests) import this
 * directly for raw/admin work that must bypass both the Proxy routing and
 * the tenant ALS.
 */
export const rawPrisma = new PrismaClient({
  log:
    process.env.PRISMA_DEBUG === '1'
      ? ['query', 'warn', 'error']
      : ['warn', 'error'],
});

/** Read the current tenant context, or `undefined` if outside any boundary. */
export function getTenantContext(): TenantContext | undefined {
  return storage.getStore()?.ctx;
}

/**
 * Read the active transaction client. The `prisma` Proxy in `client.ts` uses
 * this to dispatch each operation on the same connection where `SET LOCAL`
 * was applied.
 */
export function getActiveTx(): Prisma.TransactionClient | undefined {
  return storage.getStore()?.tx;
}

/**
 * RFC 4122 UUID regex. Used to harden against bad input from JWT claims —
 * Postgres would reject non-UUIDs when casting inside the RLS policy, but
 * catching early gives better errors and avoids wasting a tx.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertValidCompanyId(companyId: string): void {
  if (!UUID_RE.test(companyId)) {
    throw new Error(
      `Invalid companyId (expected UUID v1–v8): ${JSON.stringify(companyId)}`,
    );
  }
}

/**
 * Run `fn` inside a tenant-scoped interactive transaction.
 *
 * Opens one Postgres transaction, sets the session-local config on that
 * connection, stores the transaction client in ALS, and invokes `fn`. Every
 * Prisma operation made via the exported `prisma` Proxy (in `client.ts`)
 * inside `fn` will be routed through this same transaction — so RLS policies
 * see the correct `app.company_id` / `app.bypass_rls`.
 *
 * Safety notes:
 *   * `set_config(setting, value, is_local=TRUE)` ties the setting to the
 *     current transaction; it is released on COMMIT/ROLLBACK automatically.
 *   * We validate `companyId` against a UUID regex before sending — Postgres
 *     would error later anyway, but we fail fast with a better message.
 *   * Values go through Prisma's parameterized `$executeRaw` tagged template
 *     (NOT string interpolation) — no SQL-injection surface.
 *   * If `fn` throws, the transaction rolls back automatically.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (!ctx.bypassRls) {
    assertValidCompanyId(ctx.companyId);
  }
  return rawPrisma.$transaction(async (tx) => {
    if (ctx.bypassRls) {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'true', TRUE)`;
    } else {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${ctx.companyId}, TRUE)`;
    }
    return storage.run({ ctx, tx }, () => Promise.resolve(fn()));
  });
}
