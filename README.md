# Dorm SaaS

LINE-first multi-tenant SaaS for Thai dormitory & apartment management.

> **Status:** Phase 1 — Foundation. Solo-dev MVP, 1-month sprint to one real dormitory.

---

## Stack

- **Runtime + PM:** Bun 1.1.x (runtime + package manager + workspaces) — see ADR-0006
- **Monorepo orchestrator:** Turborepo 2.x (cache + task graph)
- **Admin Web:** Next.js 15 + TypeScript + Tailwind + shadcn/ui
- **Tenant LIFF:** Vite + React + TypeScript + Tailwind
- **API:** NestJS + Fastify
- **DB:** PostgreSQL 16 + Prisma (RLS)
- **Cache/Queue:** Redis + BullMQ
- **Storage:** Cloudflare R2
- **Lint/Format:** Biome
- **Test:** Vitest
- **CI:** GitHub Actions

See `CLAUDE.md` for the full architecture contract and domain glossary.

---

## Repo layout

```
dorm-saas/
├── apps/
│   ├── api/             # NestJS backend (port 4000)
│   ├── web-admin/       # Next.js admin dashboard (port 3000)
│   └── liff-tenant/     # Vite LIFF app (port 5173)
├── packages/
│   ├── db/              # Prisma schema + client + migrations + seed
│   ├── shared/          # Zod schemas, types, constants, error codes
│   ├── ui/              # shadcn primitives shared between web-admin (and later LIFF)
│   ├── line/            # LINE SDK wrapper (per-tenant client, webhook verify)
│   └── billing/         # Pure billing/invoice/slip-matching domain logic
├── docs/
│   └── adr/             # Architecture Decision Records
├── scripts/             # Repo maintenance scripts (no runtime code)
├── .github/workflows/   # CI
├── biome.json
├── bunfig.toml
├── tsconfig.base.json
├── turbo.json
└── package.json         # workspaces: apps/*, packages/*
```

---

## Prerequisites

- **Bun ≥ 1.1.30** — install: `curl -fsSL https://bun.sh/install | bash` (see `.bun-version`)
- **Node 20 LTS** (optional) — kept as a fallback runtime for DevOps and for tools
  that still assume Node (`nvm use` — see `.nvmrc`). Application code must run on both.
- **Docker** (for local Postgres + Redis)
- **LINE Developers account** (for LIFF & Messaging API in dev)
- **Cloudflare R2 bucket** (free tier OK)

---

## Quickstart

```bash
# 1. Clone & install
bun install

# 2. Copy env template
cp .env.example .env
# fill in values for DATABASE_URL, REDIS_URL, JWT_SECRET, LINE_*, R2_*

# 3. Start local infra (Postgres + Redis)
docker compose up -d        # (compose file added in Phase 1 step 2)

# 4. Generate Prisma client + run migrations
bun run db:generate
bun run db:migrate

# 5. Seed dev data (2 companies for RLS testing)
bun run db:seed

# 6. Run everything in dev mode
bun run dev
```

Web Admin:  http://localhost:3000
API:        http://localhost:4000
LIFF Dev:   http://localhost:5173

---

## Common scripts

| Command                | What it does                                                     |
| ---------------------- | ---------------------------------------------------------------- |
| `bun run dev`          | Run all apps in dev (parallel, via Turborepo)                    |
| `bun run build`        | Build everything                                                 |
| `bun run lint`         | Biome check (lint + format check)                                |
| `bun run lint:fix`     | Biome check + apply fixes                                        |
| `bun run typecheck`    | `tsc --noEmit` across all packages                               |
| `bun run test`         | Vitest across all packages                                       |
| `bun run check:bun-api`| Fail-on-`Bun.*` usage guard (see ADR-0006 portability rule)      |
| `bun run db:generate`  | Regenerate Prisma client                                         |
| `bun run db:migrate`   | Run dev migration (interactive)                                  |
| `bun run db:studio`    | Open Prisma Studio                                               |
| `bun run db:seed`      | Seed 2 companies + sample units                                  |

---

## Architecture decisions

See `docs/adr/`:

- ADR-0001 — Monorepo with Turborepo + pnpm *(partially superseded by 0006)*
- ADR-0002 — Multi-tenant via Row-Level Security
- ADR-0003 — Bring-Your-Own LINE OA (per-tenant credentials)
- ADR-0004 — Path-based routing `/c/{slug}/...`
- ADR-0005 — Money as `Decimal(10,2)`, never `Float`
- ADR-0006 — Bun as Runtime + Package Manager (Node-compatible subset)

---

## Conventions

- **Branches:** `feat/<short-name>`, `fix/<short-name>`, `chore/<short-name>`
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`)
- **PRs:** must answer `RLS impact? Audit log? Idempotent? Node-compatible?` in description
- **Definition of Done:** see `CLAUDE.md` §6
- **Runtime portability:** no `Bun.*` globals in `apps/**` or `packages/**` (ADR-0006)

---

## License

Proprietary — Internal Use Only.
