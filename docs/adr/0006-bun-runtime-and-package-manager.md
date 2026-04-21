# ADR-0006 — Bun as Runtime + Package Manager (supersedes pnpm portion of ADR-0001)

- **Status:** Accepted
- **Date:** 2026-04-21
- **Supersedes:** ADR-0001 (package manager choice only; Turborepo is retained)

## Context

ADR-0001 picked pnpm + Node 20 LTS. Real-world priorities have shifted:

1. **Application performance matters** — LINE webhooks, slip uploads, and invoice
   batches should respond as fast as possible.
2. **Install / cold-start speed** is a daily DX multiplier for a solo dev.
3. **Build tool unification** — Bun ships package manager + runtime + transpiler +
   test runner + bundler in one binary.

At the same time:

- **DevOps owns deploy** — we don't know if prod will run on Node or Bun.
- **Some tier-1 libraries** (Next.js 15, Prisma, NestJS) are Node-first.
- **Solo-dev 1-month MVP** — every runtime-specific debugging hour is a feature lost.

## Decision

Use **Bun 1.1.x** as the **dev runtime and package manager** for the whole
monorepo, while writing code as a **Node-compatible subset** so DevOps can deploy
on either runtime without a rewrite.

Concretely:

- `bun install` instead of `pnpm install`
- `bun run <script>` instead of `pnpm <script>`
- Root `package.json` uses the standard `workspaces: ["apps/*", "packages/*"]`
  field (no `pnpm-workspace.yaml`)
- `bunfig.toml` pins settings: `linker = "isolated"` (pnpm-style, no phantom deps),
  `exact = true` on install
- `bun.lock` (text format, Bun 1.1+) is committed
- `packageManager` field in root `package.json` set to `"bun@1.1.38"`
- Turborepo **retained** for monorepo caching + task orchestration
- Vitest **retained** as the test runner (not `bun test` — see below)
- Biome **retained** for lint/format (runtime-agnostic)

### Hard rules (to keep runtime optionality)

1. **No `Bun.*` global APIs in app code.** If a Bun-only API is tempting, wrap
   it behind an adapter that has a Node fallback (example: `Bun.password` →
   wrap around `@node-rs/argon2`).
2. **HTTP server = Fastify via NestJS adapter**, not `Bun.serve`. Keep the
   framework boundary.
3. **Worker queues = BullMQ + ioredis**, not `Bun.serve` worker. Portable.
4. **Crypto = Node `crypto` module**, not `Bun.password` or `Bun.hash`. Portable.
5. **File I/O in workers = `node:fs/promises`**, not `Bun.file`.
6. **Test runner = Vitest**, not `bun test`. Vitest runs on both runtimes.
7. **Prisma:** set `engineType = "library"` (default). Bun's query-engine support
   for `"binary"` has edge cases. Library is the safer path.
8. **Next.js 15 dev:** `bun --bun next dev` (forces Bun runtime). Production
   build output is Node-compatible by default (`next build` → Node server).
9. **NestJS dev:** `bun --bun nest start --watch`. NestJS officially supports
   Bun from v10.3+.
10. **Native deps:** prefer pure-JS or Rust-based npm packages (`@node-rs/*`,
    `bcryptjs`) over native `bcrypt` / `sharp` builds when alternatives exist.

## Rationale

- **Speed:** `bun install` is measurably faster than `pnpm install` on cold cache;
  `bun --bun` runtime startup is faster than Node; hot reload is snappier.
- **One binary:** one less tool to version-manage on a solo-dev machine.
- **Bail-out path:** the rules above keep every line of code Node-compatible.
  Switching back to Node is `bun install` → `npm install` + flipping the run
  command. No framework rewrite.
- **Ecosystem reality 2026:** Bun hit 1.1 in 2024 and has since stabilized
  NestJS + Prisma + Next.js 15 support. The "compatibility FUD" from 2023 is
  mostly resolved.

## Alternatives considered

- **Stay on Node + pnpm (ADR-0001 original)** — safest. Rejected because Ice
  rated perf = timeline equally, and the Bun gains are real during dev.
- **Bun package manager only, Node runtime** — captures ~80% of install-speed
  gain with zero runtime risk, but leaves the runtime perf win on the table.
  Rejected because of priority #2.
- **Full Bun, including `bun test` + `Bun.serve`** — fastest possible, but hard
  lock-in to one runtime. Rejected because DevOps may standardize on Node.
- **Deno 2** — genuinely interesting (TS-native, secure-by-default), but
  NestJS + Prisma + Next.js support is weaker. Rejected.

## Consequences

- `pnpm-workspace.yaml` and `.npmrc` are removed; `bunfig.toml` replaces them.
- CI uses `oven-sh/setup-bun@v2` instead of `pnpm/action-setup`.
- `bun.lock` (text) is committed — reviewable in PRs, unlike old `bun.lockb`.
- Every PR description must confirm: **"uses only Node-compatible APIs"** if
  touching runtime code (added to PR template).
- A lint rule (biome custom rule or grep pre-commit) flags `Bun.` usage in
  `apps/**/*.ts` and `packages/**/*.ts` — only allowed in scripts under `scripts/`.
- If a library forces a Bun-incompatible native binding, we document it in this
  ADR's "Known gotchas" section rather than silently patching.
- Revert path: delete `bunfig.toml`, restore `pnpm-workspace.yaml` + `.npmrc`,
  run `pnpm import` from `bun.lock`, update CI. ~30 min of work.

## Known gotchas (update as they're found)

- _(none yet — populate as we hit them)_
