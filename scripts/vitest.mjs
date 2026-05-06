#!/usr/bin/env node
/**
 * scripts/vitest.mjs — host vitest under Node, NEVER under Bun.
 *
 * Two layered Bun + vitest issues this wrapper addresses:
 *
 * 1. Bun 1.3.3 + vitest 2.1.8 cannot bootstrap test workers under any pool
 *    strategy:
 *      - pool: 'threads' → tinypool calls `port.addListener('message', fn)`
 *        on Bun's `node:worker_threads` MessagePort, which only exposes `.on`.
 *        Workers crash before any test loads. Symptom: "Tests: no tests,
 *        Errors: 6 errors", error path through tinypool/dist/entry/worker.js.
 *      - pool: 'forks'   → Bun's `child_process.fork()` spawns the child as
 *        Bun (inherits parent runtime), so the forked process hits the same
 *        worker_threads gap when tinypool spins up its inner pool.
 *
 *    Verified working: the IDENTICAL vitest invocation under Node runs all
 *    298 shared-package tests in 1.82s. The fix is therefore not at the
 *    vitest config layer — it's "use Node, not Bun, to host vitest."
 *
 * 2. `bun run` automatically substitutes `node` with `bun` when parsing
 *    package.json script commands (documented in bun docs/cli/run). So even
 *    `"test": "node scripts/vitest.mjs --run"` runs THIS file under Bun, not
 *    Node — and `process.execPath` then points at the Bun binary, which
 *    means our subsequent `spawnSync(process.execPath, ...)` would launch
 *    vitest under Bun anyway, defeating the whole exercise.
 *
 *    Workaround below: detect `process.versions.bun`, locate a real Node
 *    binary in PATH (filtering out anything Bun substitutes back to itself),
 *    and re-exec this same script under that binary. From the re-exec
 *    onwards, `process.execPath` is real Node and vitest is happy.
 *
 * Bun is still the right choice for everything else in this repo (per
 * ADR-0006 and CLAUDE.md §2). This wrapper only forces Node for the test
 * subprocess; the outer `bun run` orchestration + env loading stays Bun.
 *
 * Usage in package.json:
 *   "test":       "node ../../scripts/vitest.mjs --run",
 *   "test:watch": "node ../../scripts/vitest.mjs",
 *
 * Cwd matters — vitest uses the current directory to locate
 * `vitest.config.ts`. Always invoke from the package directory (which
 * `bun run --filter` / `--cwd` already does for workspace scripts).
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Stage 1 — if we're running under Bun (because `bun run` swapped `node` for
// `bun` in the script command), find real Node and re-exec ourselves there.
// ---------------------------------------------------------------------------
if (typeof process.versions.bun === 'string') {
  const realNode = findRealNode();
  if (!realNode) {
    console.error('[vitest-wrapper] running under Bun, but no real Node binary found in PATH.');
    console.error('[vitest-wrapper] install Node 18+ and ensure `node` resolves outside of Bun');
    console.error(
      '[vitest-wrapper] (`where node` on Windows / `which -a node` on POSIX should list it).',
    );
    process.exit(1);
  }

  const reexec = spawnSync(realNode, [SCRIPT_PATH, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });
  if (reexec.signal) {
    process.kill(process.pid, reexec.signal);
  }
  process.exit(reexec.status ?? 1);
}

// ---------------------------------------------------------------------------
// Stage 2 — we are real Node. Resolve vitest from the caller's cwd (the
// workspace package being tested), NOT from this script's location. vitest
// is a devDep of each test-running package (shared, db, api) but NOT of the
// repo root, so a `createRequire` rooted at `import.meta.url` (= scripts/)
// walks up and finds nothing. Anchoring at `<cwd>/package.json` makes Node's
// resolver walk packages/<x>/node_modules → root/node_modules in order,
// hitting the Bun-installed copy regardless of hoist layout.
// ---------------------------------------------------------------------------
const cwdRequire = createRequire(join(process.cwd(), 'package.json'));

let vitestBin;
try {
  vitestBin = cwdRequire.resolve('vitest/vitest.mjs');
} catch (err) {
  console.error(`[vitest-wrapper] could not resolve vitest/vitest.mjs from cwd: ${process.cwd()}`);
  console.error('[vitest-wrapper] underlying error:', err?.message ?? err);
  console.error(
    '[vitest-wrapper] vitest must be a devDep of the package whose tests you are running.',
  );
  console.error('[vitest-wrapper] run `bun install` from the repo root first.');
  process.exit(1);
}

// Forward extra CLI args (--run, --config, file globs, etc.) untouched.
// stdio:'inherit' keeps the colour reporter + interactive watch mode working.
const result = spawnSync(process.execPath, [vitestBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

// SIGINT / SIGTERM — propagate the signal so `Ctrl+C` in watch mode exits
// cleanly without an unhandled-error frame.
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk PATH looking for a binary named `node` that is actually Node — not
 * Bun masquerading via `bun run`'s automatic command substitution.
 *
 * Strategy: enumerate every `node` entry in PATH (`where node` on Windows,
 * `which -a node` on POSIX), then probe each with a tiny script that prints
 * `typeof process.versions.bun`. Real Node prints `undefined`; Bun prints
 * `string`. First Node wins. We bypass shell substitution because we invoke
 * each candidate by its absolute resolved path — Bun's `node`-swap only
 * affects the bare command in package.json scripts, not absolute paths
 * passed to `child_process.spawnSync`.
 *
 * Returns the first real-Node absolute path, or `null` if none found.
 */
function findRealNode() {
  const isWin = process.platform === 'win32';
  const lookupCmd = isWin ? 'where' : 'which';
  const lookupArgs = isWin ? ['node'] : ['-a', 'node'];

  const lookup = spawnSync(lookupCmd, lookupArgs, { encoding: 'utf8' });
  if (lookup.status !== 0 || !lookup.stdout) {
    return null;
  }

  const candidates = lookup.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate,
      ['-e', 'process.stdout.write(typeof process.versions.bun)'],
      { encoding: 'utf8', timeout: 5_000 },
    );
    if (probe.status === 0 && probe.stdout.trim() === 'undefined') {
      return candidate;
    }
  }
  return null;
}
