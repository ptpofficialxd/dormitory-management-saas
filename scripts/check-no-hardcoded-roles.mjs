#!/usr/bin/env node
/**
 * CLAUDE.md section 3 #13 guard — "RBAC is table-driven. Never hard-code role checks."
 *
 * Fails CI if any file under apps/api/src/** references the legacy @Roles(...)
 * decorator (or imports the Roles symbol). New code must use
 * @Perm(action, resource) from apps/api/src/common/decorators/perm.decorator.ts,
 * which resolves the allowed-role set from the shared RBAC matrix at decoration
 * time — single source of truth = packages/shared/src/rbac/index.ts.
 *
 * Allow-list (the decorator's own definition file):
 *   - apps/api/src/common/decorators/roles.decorator.ts
 *
 * Matching strategy:
 *   - Blank out comments + string/template literals first (preserving offsets),
 *     so docstrings and error messages that mention @Roles(...) don't false-
 *     positive.
 *   - Then scan for \bRoles\b as code. Case-sensitive so ROLES_KEY (the
 *     metadata key, which IS still imported by perm.decorator + guard) is
 *     intentionally NOT caught.
 *
 * Runs under either Node or Bun — uses only portable APIs.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { cwd, exit } from 'node:process';

const ROOT = cwd();
const SCAN_DIRS = ['apps/api/src'];
const EXT_ALLOW = new Set(['.ts', '.tsx', '.mts', '.cts']);
const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.vercel',
  'coverage',
  'generated',
]);

/** Files where the Roles identifier is legitimately allowed (decorator source). */
const ALLOW_FILES = new Set(['apps/api/src/common/decorators/roles.decorator.ts']);

const FORBIDDEN_PATTERNS = [
  {
    re: /@Roles\s*\(/g,
    label: 'Roles decorator — use Perm(action, resource) instead',
  },
  {
    re: /\bRoles\b/g,
    label: 'Roles identifier — use Perm from perm.decorator.js',
  },
];

async function walk(dir) {
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
      const dot = entry.name.lastIndexOf('.');
      if (dot !== -1 && EXT_ALLOW.has(entry.name.slice(dot))) out.push(full);
    }
  }
  return out;
}

/**
 * Blank out block comments, line comments, and string/template literals
 * while preserving length 1:1 (non-newline chars become spaces, newlines
 * stay) so regex offsets map back cleanly to the original source for
 * accurate line/col reporting.
 */
function stripCommentsAndStrings(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let j = from; j < to; j++) if (out[j] !== '\n') out[j] = ' ';
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blank(start, i);
      continue;
    }
    if (c === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      blank(start, i);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      const start = i;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i += 2;
        else i++;
      }
      i = Math.min(n, i + 1);
      blank(start, i);
      continue;
    }
    i++;
  }
  return out.join('');
}

async function main() {
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

  const hits = [];
  const seen = new Set();

  for (const file of allFiles) {
    const relFile = relative(ROOT, file).split(sep).join('/');
    if (ALLOW_FILES.has(relFile)) continue;

    const src = await readFile(file, 'utf8');
    const stripped = stripCommentsAndStrings(src);
    for (const { re, label } of FORBIDDEN_PATTERNS) {
      re.lastIndex = 0;
      let m = re.exec(stripped);
      while (m !== null) {
        const offset = m.index;
        const key = `${relFile}:${offset}`;
        if (seen.has(key)) {
          m = re.exec(stripped);
          continue;
        }
        seen.add(key);
        const before = src.slice(0, offset);
        const line = before.split('\n').length;
        const col = offset - before.lastIndexOf('\n');
        const snippet = src.split('\n')[line - 1]?.trim() ?? '';
        hits.push({ file: relFile, line, col, label, snippet });
        m = re.exec(stripped);
      }
    }
  }

  if (hits.length === 0) {
    console.log(
      `ok - no hard-coded @Roles usage in ${SCAN_DIRS.join(', ')} (${allFiles.length} files scanned).`,
    );
    exit(0);
  }

  console.error(
    `\nx RBAC guard (CLAUDE.md section 3 #13): found ${hits.length} hard-coded role reference(s).\n`,
  );
  console.error('  Use @Perm(action, resource) - it resolves allowed roles from the shared');
  console.error('  RBAC matrix at decoration time. Example:');
  console.error("    @Perm('create', 'property')   // instead of @Roles('company_owner', ...)");
  console.error('');
  console.error('  Matrix source of truth: packages/shared/src/rbac/index.ts\n');
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}:${h.col}  [${h.label}]`);
    console.error(`    ${h.snippet}`);
  }
  console.error('');
  exit(1);
}

main().catch((err) => {
  console.error('check-no-hardcoded-roles.mjs crashed:', err);
  exit(2);
});
