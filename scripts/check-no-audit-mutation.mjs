#!/usr/bin/env node
/**
 * Audit-log append-only guard (Task #116).
 *
 * The DB-level BEFORE UPDATE/DELETE triggers on `audit_log` were dropped in
 * migration 20260506110000 to let Prisma Studio + GDPR erasure scripts
 * delete Companies without a superuser session. This script enforces the
 * append-only invariant at the application layer instead — fails CI if any
 * service code calls `prisma.auditLog.update*` / `prisma.auditLog.delete*`
 * (or the equivalent on `tx.auditLog` inside a transaction).
 *
 * Allowed call sites (skipped from scanning):
 *   - Test files (`*.test.ts`, `*.e2e-test.ts`, anything under `**\/test/**`).
 *     Test cleanup needs to wipe audit rows between runs; the runtime
 *     contract still holds.
 *   - This script itself.
 *
 * Runs under either Node or Bun — uses only portable APIs. Mirrors
 * `scripts/check-no-bun-api.mjs` style.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { cwd, exit } from 'node:process';

const ROOT = cwd();
const SCAN_DIRS = ['apps', 'packages'];
const EXT_ALLOW = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.vercel',
  'coverage',
  'generated',
  'test', // test/e2e fixtures may need to wipe audit rows for cleanup
  'tests',
  '__tests__',
]);

// Forbidden mutation methods — anything that writes to or removes from audit_log.
const FORBIDDEN_PATTERNS = [
  {
    re: /\b(?:prisma|tx|client|cleanupClient)\.auditLog\.(update|updateMany|delete|deleteMany|upsert)\b/g,
    label: 'audit_log mutation',
  },
];

/** Files whose names indicate they are tests (allowed to mutate audit_log). */
const TEST_FILE_RE = /\.(test|spec|e2e-test|e2e|integration)\.[mc]?[tj]sx?$/;

/** @param {string} dir */
async function walk(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      // Skip test files — they're allowed to wipe audit rows for cleanup.
      if (TEST_FILE_RE.test(entry.name)) continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot !== -1 && EXT_ALLOW.has(entry.name.slice(dot))) out.push(full);
    }
  }
  return out;
}

/**
 * Strip comments and string literals so we don't false-positive on docstrings.
 * @param {string} src
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i += 2;
        else i++;
      }
      i++;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

async function main() {
  /** @type {string[]} */
  const allFiles = [];
  for (const d of SCAN_DIRS) {
    const abs = join(ROOT, d);
    try {
      await stat(abs);
    } catch {
      continue;
    }
    allFiles.push(...(await walk(abs)));
  }

  /** @type {{ file: string; line: number; col: number; label: string; snippet: string }[]} */
  const hits = [];

  for (const file of allFiles) {
    const src = await readFile(file, 'utf8');
    const stripped = stripCommentsAndStrings(src);
    for (const { re, label } of FORBIDDEN_PATTERNS) {
      re.lastIndex = 0;
      let m = re.exec(stripped);
      while (m !== null) {
        const offset = m.index;
        const before = src.slice(0, offset);
        const line = before.split('\n').length;
        const col = offset - before.lastIndexOf('\n');
        const snippet = src.split('\n')[line - 1]?.trim() ?? '';
        hits.push({
          file: relative(ROOT, file).split(sep).join('/'),
          line,
          col,
          label: `${label} (.${m[1]})`,
          snippet,
        });
        m = re.exec(stripped);
      }
    }
  }

  if (hits.length === 0) {
    console.log(
      `ok — audit_log append-only invariant holds (${allFiles.length} files scanned, tests skipped).`,
    );
    exit(0);
  }

  console.error(`\n✖ audit_log append-only guard: found ${hits.length} mutation call(s).\n`);
  console.error('  audit_log is append-only (CLAUDE.md §3.7) — service code MUST NOT call');
  console.error('  prisma.auditLog.update*/delete*/upsert. Need to clean up audit rows for a');
  console.error('  test? Move the call into a *.test.ts / *.e2e-test.ts file.\n');
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}:${h.col}  [${h.label}]`);
    console.error(`    ${h.snippet}`);
  }
  console.error('');
  exit(1);
}

main().catch((err) => {
  console.error('check-no-audit-mutation.mjs crashed:', err);
  exit(2);
});
