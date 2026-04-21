#!/usr/bin/env node
/**
 * ADR-0006 portability guard.
 *
 * Fails CI if any file under `apps/**` or `packages/**` uses a Bun-only global.
 * Application code must run on both Bun and Node. Runtime-specific code, if
 * unavoidable, must live under `scripts/**` (not shipped to runtime) or be
 * wrapped behind an adapter with a Node fallback.
 *
 * Runs under either Node or Bun — uses only portable APIs.
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
]);

// Patterns that indicate use of a Bun-only runtime API.
// Intentionally conservative — only flag actual usage, not mentions in strings or comments.
const FORBIDDEN_PATTERNS = [
  // `Bun.<something>(`  or  `Bun.<something>.`  or  assignment/destructure
  { re: /\bBun\.\w+/g, label: 'Bun.* global' },
  // import from "bun"
  { re: /from\s+['"]bun['"]/g, label: "import from 'bun'" },
  { re: /require\(['"]bun['"]\)/g, label: "require('bun')" },
  // bun:* specifiers (bun:test, bun:sqlite, bun:ffi, ...)
  { re: /from\s+['"]bun:[\w-]+['"]/g, label: "import from 'bun:*'" },
  { re: /require\(['"]bun:[\w-]+['"]\)/g, label: "require('bun:*')" },
];

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
      const dot = entry.name.lastIndexOf('.');
      if (dot !== -1 && EXT_ALLOW.has(entry.name.slice(dot))) out.push(full);
    }
  }
  return out;
}

/**
 * Strip block comments and line comments + string literals so we don't false-positive on
 * docstrings / examples. Not a full tokenizer — good enough for grep-lint.
 * @param {string} src
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    // line comment
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // block comment
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // string / template
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i += 2;
        else i++;
      }
      i++;
      out += ' '; // placeholder preserves offsets loosely
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
      continue; // dir may not exist yet during bootstrap
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
          label,
          snippet,
        });
        m = re.exec(stripped);
      }
    }
  }

  if (hits.length === 0) {
    console.log(
      `ok — no Bun-only APIs in ${SCAN_DIRS.join(', ')} (${allFiles.length} files scanned).`,
    );
    exit(0);
  }

  console.error(`\n✖ ADR-0006 portability guard: found ${hits.length} Bun-only API usage(s).\n`);
  console.error('  App code must run on both Bun and Node. Wrap runtime-specific calls');
  console.error('  behind an adapter with a Node fallback.\n');
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}:${h.col}  [${h.label}]`);
    console.error(`    ${h.snippet}`);
  }
  console.error('');
  exit(1);
}

main().catch((err) => {
  console.error('check-no-bun-api.mjs crashed:', err);
  exit(2);
});
