import type { PrismaClient } from '@prisma/client';
import { assertValidCompanyId, getActiveTx, rawPrisma } from './tenant-context.js';

export { rawPrisma };

/**
 * Public Prisma client — a Proxy over `rawPrisma` that transparently routes
 * every delegate access to the current tenant transaction (from ALS) when
 * one is active.
 *
 * Behaviour:
 *   • Inside `withTenant(ctx, fn)`: every `prisma.x.y(...)` call goes through
 *     the interactive-tx client whose connection has `SET LOCAL app.company_id`
 *     / `app.bypass_rls` applied. RLS policies see the correct values.
 *   • Outside `withTenant`: calls go through `rawPrisma` (no tx, no SET LOCAL).
 *     RLS policies see NULL and default-deny → 0 rows / write rejection. Loud
 *     failure is better than silent cross-tenant leak.
 *
 * Why a Proxy instead of `$extends`?
 *   A `$extends` middleware's `query(args)` dispatches on the base client and
 *   may use a DIFFERENT pool connection than the one where `SET LOCAL` was
 *   set (extension wraps `$transaction(async tx => { SET; query(args) })`,
 *   but `query` is bound to base — not to `tx`). The Proxy routes through
 *   the tx client explicitly, so both ops always run on the same connection.
 *
 * Gotchas:
 *   • Prisma's `TransactionClient` does not expose `$transaction`,
 *     `$connect`, `$disconnect`, `$on`, `$use`, `$extends`. Calling those on
 *     `prisma` inside `withTenant` will throw — app code should never need to.
 *   • `prisma.$executeRaw` / `prisma.$queryRaw` DO route through tx and
 *     therefore DO inherit the tenant context — safe for RLS-aware raw SQL.
 */
export const prisma = new Proxy(rawPrisma, {
  get(target, prop, _receiver) {
    const tx = getActiveTx();
    const source: object = tx ?? target;
    const value = Reflect.get(source, prop, source);
    // Bind methods so `this` is preserved regardless of how the caller invokes
    // the returned value (detaching via destructuring, etc.). Delegates like
    // `prisma.property` are plain objects — `typeof value === 'function'` is
    // false — so they pass through unbound, and method calls on them
    // (`.findMany(...)`) use the delegate's own `this` from the tx client.
    return typeof value === 'function' ? value.bind(source) : value;
  },
}) as PrismaClient;

/**
 * Public Prisma client type. Downstream consumers should alias this rather
 * than importing `PrismaClient` directly so we keep a single source of truth.
 */
export type DormPrismaClient = typeof prisma;

/**
 * Convenience factory for short-lived ad-hoc contexts. Prefer `withTenant()`
 * at the request boundary and use the `prisma` singleton inside handlers.
 */
export function createTenantClient(companyId: string): DormPrismaClient {
  assertValidCompanyId(companyId);
  // Same singleton — ALS handles concurrency. Caller must still wrap in
  // `withTenant({ companyId }, () => prisma.x.findMany())`.
  return prisma;
}

/**
 * Admin client factory — returns the same singleton. The caller still needs
 * `withTenant({ companyId: '', bypassRls: true }, fn)` to set `app.bypass_rls`.
 */
export function createAdminClient(): DormPrismaClient {
  return prisma;
}

/** Explicit shutdown — call from a process SIGTERM handler in apps. */
export async function disconnect(): Promise<void> {
  await rawPrisma.$disconnect();
}
