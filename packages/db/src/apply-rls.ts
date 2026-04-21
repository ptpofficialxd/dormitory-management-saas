/**
 * Apply RLS policies and triggers to the database.
 *
 * Reads `prisma/rls-policies.sql`, splits it into individual statements
 * (respecting dollar-quoted function bodies), and executes each one inside a
 * single transaction for atomicity.
 *
 * Why split? Prisma's `$executeRawUnsafe` sends queries via the PostgreSQL
 * extended query protocol, which only allows ONE statement per call
 * (error 42601: "cannot insert multiple commands into a prepared statement").
 * We therefore parse the file ourselves.
 *
 * The SQL file itself is idempotent (DROP ... IF EXISTS → CREATE) so this
 * script is safe to re-run after any schema migration that adds tables.
 *
 * Usage:
 *   bun run apply-rls            # picks DATABASE_URL from .env (via dotenv-cli)
 *   DATABASE_URL=... bun run ... # or provide inline
 *
 * This script intentionally does NOT use the extended `prisma` client from
 * `client.ts` — it needs raw DDL privileges and no RLS context.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = resolve(__dirname, '..', 'prisma', 'rls-policies.sql');

/**
 * Split a PostgreSQL script into individual statements.
 *
 * Handles:
 *   - `-- line comments` (kept attached to the following statement, harmless)
 *   - `/* block comments *\/`
 *   - `'single-quoted strings'` with `''` escapes
 *   - `"double-quoted identifiers"`
 *   - `$tag$ ... $tag$` dollar-quoted strings (PL/pgSQL function bodies)
 *   - `;` as statement terminator (only when in normal state)
 *
 * Does NOT execute `BEGIN` / `COMMIT` — those are stripped because we wrap
 * everything in Prisma's `$transaction`.
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    // Line comment: -- ... \n
    if (ch === '-' && next === '-') {
      while (i < len && sql[i] !== '\n') {
        current += sql[i];
        i++;
      }
      continue;
    }

    // Block comment: /* ... */
    if (ch === '/' && next === '*') {
      current += ch;
      current += next!;
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) {
        current += sql[i];
        i++;
      }
      if (i < len) {
        current += sql[i]!;     // *
        current += sql[i + 1]!; // /
        i += 2;
      }
      continue;
    }

    // Single-quoted string (with '' escape)
    if (ch === "'") {
      current += ch;
      i++;
      while (i < len) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          current += "'";
          i++;
          break;
        }
        current += sql[i];
        i++;
      }
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      current += ch;
      i++;
      while (i < len && sql[i] !== '"') {
        current += sql[i];
        i++;
      }
      if (i < len) {
        current += sql[i]!; // closing "
        i++;
      }
      continue;
    }

    // Dollar-quoted string: $tag$ ... $tag$  (tag may be empty → $$)
    if (ch === '$') {
      const tagMatch = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0]; // e.g. "$$" or "$body$"
        current += tag;
        i += tag.length;
        const closeIdx = sql.indexOf(tag, i);
        if (closeIdx === -1) {
          // Malformed — consume rest of input so we don't loop forever.
          current += sql.slice(i);
          i = len;
        } else {
          current += sql.slice(i, closeIdx + tag.length);
          i = closeIdx + tag.length;
        }
        continue;
      }
    }

    // Statement terminator
    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const trailing = current.trim();
  if (trailing.length > 0) statements.push(trailing);
  return statements;
}

/**
 * Drop transaction-control statements — we wrap the whole run in Prisma's
 * `$transaction` already, so nested BEGIN/COMMIT would error out.
 */
function isTransactionControl(stmt: string): boolean {
  const firstWord = stmt
    .replace(/^\s*(--[^\n]*\n)*/g, '') // strip leading line comments
    .trim()
    .split(/\s+/)[0]
    ?.toUpperCase();
  return (
    firstWord === 'BEGIN' ||
    firstWord === 'COMMIT' ||
    firstWord === 'ROLLBACK' ||
    firstWord === 'START' // START TRANSACTION
  );
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Did you copy .env.example to .env?');
    process.exit(1);
  }

  const sql = await readFile(SQL_PATH, 'utf8');
  const allStatements = splitSqlStatements(sql);
  const statements = allStatements.filter((s) => !isTransactionControl(s));

  console.log(`Applying RLS policies from ${SQL_PATH}`);
  console.log(
    `  Parsed ${allStatements.length} statements ` +
      `(${allStatements.length - statements.length} transaction-control stripped, ` +
      `${statements.length} to execute)`,
  );

  const client = new PrismaClient();
  try {
    await client.$transaction(async (tx) => {
      for (let idx = 0; idx < statements.length; idx++) {
        const stmt = statements[idx]!;
        const preview = stmt.replace(/\s+/g, ' ').slice(0, 72);
        console.log(`  [${idx + 1}/${statements.length}] ${preview}${stmt.length > 72 ? '…' : ''}`);
        await tx.$executeRawUnsafe(stmt);
      }
    });
    console.log('RLS policies applied successfully.');
  } catch (err) {
    console.error('Failed to apply RLS policies:', err);
    process.exitCode = 1;
  } finally {
    await client.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
