/**
 * Apply the non-privileged application role (`dorm_app`) that runtime Prisma
 * queries connect under.
 *
 * Why a separate role?
 *   The default `dorm` role from `postgres:16-alpine` is SUPERUSER + BYPASSRLS,
 *   which skips Row-Level Security policies silently — even with `FORCE ROW
 *   LEVEL SECURITY`. RLS is only enforced against non-privileged roles. This
 *   script creates `dorm_app` with NOSUPERUSER + NOBYPASSRLS, then grants the
 *   minimum privileges needed for CRUD on the app schema.
 *
 * Must be run by the privileged `dorm` role (it needs CREATE ROLE + GRANT).
 * This is the ONE place we intentionally use superuser, to bootstrap the
 * non-superuser role.
 *
 * Idempotent — safe to re-run after schema migrations (refreshes privileges
 * via ALTER DEFAULT PRIVILEGES and re-GRANTs on existing tables).
 *
 * Usage:
 *   bun run apply-roles
 *
 * Required env:
 *   ADMIN_DATABASE_URL      — connection string for SUPERUSER `dorm`
 *   DATABASE_APP_PASSWORD   — password to set on `dorm_app`
 */

import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.length === 0) {
    console.error(`[apply-roles] Missing required env: ${key}`);
    process.exit(1);
  }
  return v;
}

/**
 * Extract the database name from a postgres:// URL so we can scope the
 * CONNECT grant correctly.
 */
function dbNameFromUrl(url: string): string {
  // postgres://user:pw@host:port/dbname?params
  const match = url.match(/\/([^/?]+)(\?|$)/);
  if (!match || !match[1]) {
    throw new Error(`Could not extract db name from ADMIN_DATABASE_URL`);
  }
  return match[1];
}

/**
 * Build a PostgreSQL dollar-quoted string literal safely.
 *
 * Picks a random tag that definitely does not occur inside the payload, so
 * no escaping is needed and no SQL-injection surface exists even for exotic
 * passwords. Tag format: `pw_<hex>` — 16 hex chars of entropy.
 *
 * Postgres accepts `$tag$…$tag$` as a string literal anywhere a single-quoted
 * literal is allowed, including role `PASSWORD` clauses.
 */
function dollarQuote(payload: string): string {
  for (let attempt = 0; attempt < 4; attempt++) {
    const tag = `pw_${randomBytes(8).toString('hex')}`;
    const delim = `$${tag}$`;
    if (!payload.includes(delim)) {
      return `${delim}${payload}${delim}`;
    }
  }
  // Vanishingly unlikely with 16-hex entropy. If we still collide, bail.
  throw new Error('Could not find a non-colliding dollar-quote tag');
}

async function main(): Promise<void> {
  const adminUrl = requireEnv('ADMIN_DATABASE_URL');
  const appPw = requireEnv('DATABASE_APP_PASSWORD');
  const dbName = dbNameFromUrl(adminUrl);

  console.log(`[apply-roles] Target DB: ${dbName}`);

  const client = new PrismaClient({
    datasources: { db: { url: adminUrl } },
  });

  // Dollar-quote the password — avoids single-quote escaping entirely and
  // sidesteps the earlier 42601 error from naive `'${pw}'` interpolation.
  const pwLiteral = dollarQuote(appPw);
  const roleAttrs =
    'NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT LOGIN';

  try {
    // 1. Check if the role already exists.
    const existing = await client.$queryRawUnsafe<Array<{ rolname: string }>>(
      `SELECT rolname FROM pg_roles WHERE rolname = 'dorm_app'`,
    );
    const roleExists = existing.length > 0;

    if (roleExists) {
      console.log('[apply-roles] Updating existing dorm_app role…');
      await client.$executeRawUnsafe(
        `ALTER ROLE dorm_app WITH ${roleAttrs} PASSWORD ${pwLiteral}`,
      );
    } else {
      console.log('[apply-roles] Creating dorm_app role…');
      await client.$executeRawUnsafe(
        `CREATE ROLE dorm_app WITH ${roleAttrs} PASSWORD ${pwLiteral}`,
      );
    }

    // 2. Privileges.
    // NOTE: GRANT ... ON DATABASE must use a literal name (no parameter
    // binding for DDL). dbName comes from our own env, not user input.
    const grants = [
      `GRANT CONNECT ON DATABASE "${dbName}" TO dorm_app`,
      `GRANT USAGE ON SCHEMA public TO dorm_app`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dorm_app`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dorm_app`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE dorm IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dorm_app`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE dorm IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO dorm_app`,
      `GRANT EXECUTE ON FUNCTION app_rls_bypass() TO dorm_app`,
      `GRANT EXECUTE ON FUNCTION app_current_company_id() TO dorm_app`,
    ];

    for (let i = 0; i < grants.length; i++) {
      const stmt = grants[i]!;
      const preview = stmt.slice(0, 80);
      console.log(`  [${i + 1}/${grants.length}] ${preview}${stmt.length > 80 ? '…' : ''}`);
      await client.$executeRawUnsafe(stmt);
    }

    // 3. Verification.
    const rows = await client.$queryRawUnsafe<
      Array<{ usename: string; usesuper: boolean; usebypassrls: boolean }>
    >(
      `SELECT usename, usesuper, usebypassrls FROM pg_user WHERE usename IN ('dorm', 'dorm_app') ORDER BY usename`,
    );
    console.log('[apply-roles] Role attributes:');
    for (const r of rows) {
      console.log(
        `  ${r.usename.padEnd(10)} usesuper=${r.usesuper} usebypassrls=${r.usebypassrls}`,
      );
    }

    console.log('[apply-roles] Done.');
  } catch (err) {
    console.error('[apply-roles] Failed:', err);
    process.exitCode = 1;
  } finally {
    await client.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
