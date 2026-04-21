# ADR-0001 — Monorepo with Turborepo + pnpm

- **Status:** **Partially Superseded by ADR-0006** — Turborepo decision stands; package manager has been changed from pnpm to Bun. See ADR-0006.
- **Date:** 2026-04-21
- **Deciders:** Solo dev (Ice)

## Context

Three tightly coupled product surfaces — Admin Web, Tenant LIFF, API — must share
types (Prisma → Zod → DTOs), validation schemas, UI primitives, and LINE/billing logic.
Splitting into separate repos costs solo-dev time on every cross-cutting change.

## Decision

Single monorepo using **Turborepo + pnpm workspaces**.

- `apps/*`  — runnable apps (api, web-admin, liff-tenant)
- `packages/*` — internal libraries (db, shared, ui, line, billing)

## Rationale

- Type changes (Prisma schema, Zod) propagate via workspace links — zero publish step.
- `turbo` caches builds and tasks across packages → fast dev loop.
- pnpm content-addressable store keeps `node_modules` small.
- One `tsconfig.base.json`, one `biome.json`, one CI matrix.

## Alternatives considered

- **Polyrepo** — too much sync overhead for one developer.
- **Nx** — more powerful, more concepts to learn. Turborepo is leaner; we can migrate later.
- **Yarn workspaces / npm workspaces** — pnpm has the best disk + speed profile for solo dev.

## Consequences

- All packages must follow the same TS / lint / test stack.
- Shared `packages/*` are private (`"private": true`) — never published to npm.
- Long-term scale path is clear: extract any package into its own repo when it earns it.
