# Dorm SaaS

LINE-first multi-tenant SaaS for Thai dormitory & apartment management.

> **Status (2026-04-25):** Phase 1 + Phase 2.1 complete · 86 tasks merged · core code ~75% production-ready · awaiting infra deploy + beta dorm onboarding.

End-to-end monthly billing cycle (onboard → readings → invoice → LINE push → tenant pay → admin approve → LINE push) is working through the UI on all three surfaces.

---

## Stack

- **Runtime + PM:** Bun 1.1.x (runtime + package manager + workspaces) — see ADR-0006
- **Monorepo orchestrator:** Turborepo 2.x (cache + task graph)
- **Admin Web:** Next.js 15 + TypeScript + Tailwind + shadcn/ui (pages: `apps/web-admin`)
- **Tenant LIFF:** Vite + React + TypeScript + Tailwind + react-router (pages: `apps/liff-tenant`)
- **API:** NestJS + Fastify, Bun + Node compatible (per ADR-0006)
- **DB:** PostgreSQL 16 + Prisma 6 (RLS + pgcrypto for PII)
- **Cache/Queue:** Redis 7 + BullMQ (queues: `line-webhook`, `line-notification`, `line-broadcast`, `billing`)
- **Storage:** Cloudflare R2 (S3-compatible, private bucket + signed URLs ≤ 5 min)
- **Auth:** JWT — admin via email+password cookie; tenant via LINE LIFF idToken exchange
- **Lint/Format:** Biome (single tool, replaces ESLint + Prettier)
- **Test:** Vitest (unit + integration) — not `bun test` for portability
- **CI:** GitHub Actions + `oven-sh/setup-bun@v2`

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture contract, domain glossary, and non-negotiable rules.

---

## Repo layout (actual)

```
dorm-saas/
├── apps/
│   ├── api/                 # NestJS + Fastify backend (port 4000)
│   │   └── src/modules/     # 14 feature modules — see "API surface" below
│   ├── web-admin/           # Next.js 15 admin dashboard (port 3000)
│   │   └── src/app/c/[companySlug]/   # path-based per-tenant pages
│   └── liff-tenant/         # Vite LIFF app (port 5173)
│       └── src/pages/       # bind, invoices, pay, payment-status
├── packages/
│   ├── db/                  # Prisma schema + RLS migrations + seed + ALS proxy client
│   └── shared/              # Zod schemas, RBAC matrix, money/date/promptpay helpers
├── docs/
│   └── adr/                 # 6 Architecture Decision Records
├── scripts/                 # check-no-bun-api, check-no-hardcoded-roles, e2e-create-invite
├── .github/workflows/       # CI
├── biome.json
├── compose.yml              # local Postgres + Redis (project name pinned)
├── tsconfig.base.json
├── turbo.json
└── package.json             # workspaces: apps/*, packages/*
```

> The original brief mentioned separate `packages/ui`, `packages/line`, `packages/billing` — those are intentionally **not split out** in MVP. They live as modules inside `apps/api` and per-app components inside the web/LIFF apps. Per CLAUDE.md §8: "no generic abstractions before 3+ concrete use cases."

---

## What's done (86 tasks across 4 phases)

### ✅ Phase 0 — Foundation (Tasks #1–#23)

- Bun monorepo + Turborepo + tsconfig base + Biome
- Prisma schema + RLS policies + `dorm_app` non-privileged role + ALS+Proxy client
- 6 ADRs, GitHub Actions CI, Vitest with both Node + Bun runners
- Storage (R2 + signed URLs) + PromptPay (EMVCo QR) helpers
- Audit-log interceptor + RBAC matrix + Zod validation pipe

### ✅ Phase 1 — Core CRUD + LINE Webhook + Billing API (Tasks #24–#50)

- Domain CRUD: Property · Unit · Tenant · Contract · Meter · Reading
- Billing API: Invoice (single + batch generation) · Payment · Slip
- LINE channel (BYO per-tenant credentials, encrypted at rest)
- LINE webhook controller (HMAC verify) + worker (BullMQ) + reply handler
- Tenant invite flow (admin generate code → LIFF redeem with idToken)
- E2E billing isolation tests (RLS verified across 2 companies)

### ✅ Phase 1.5 — UI Surfaces (Tasks #51–#78)

- LIFF tenant app: bind flow + invoice list/detail + pay + slip upload + payment status
- Admin app: auth + shell + RBAC hook + Property/Unit/Invoice/Payment pages
- Tenant JWT mint (`POST /me/auth/exchange`) + `/me/*` endpoints (LIFF-scoped)
- Slip review queue, batch invoice wizard

### ✅ Phase 1 closeout (Tasks #79–#81)

- Tenants CRUD page (PII mask + reveal + status workflow)
- Contracts CRUD page + activate button (state-machine UI)
- Settings page (PromptPay payee config)

### ✅ Phase 2.1 — Monthly cycle + LINE push (Tasks #82–#86)

- Readings entry grid (per-period, water+electric, mobile-responsive)
- NotificationService + `line-notification` BullMQ queue
- Hooks: InvoiceService.issue → push, PaymentService.confirm/reject → push
- LIFF native deep-link from LINE push → invoice detail (via `liff.state` restoration)

---

## API surface (`apps/api/src/modules`)

| Module | Endpoints | Notes |
|--------|-----------|-------|
| `auth` | `POST /auth/login`, `POST /me/auth/exchange` | admin email/pw + tenant LIFF idToken |
| `company` | `GET /c/:slug`, `PUT /c/:slug/prompt-pay` | settings only in MVP |
| `property` | `GET/POST /c/:slug/properties` + detail | |
| `unit` | `GET/POST/PATCH /c/:slug/units` | |
| `tenant` | `GET/POST/PATCH /c/:slug/tenants` | PII encrypted via pgcrypto |
| `tenant-invite` | `POST /c/:slug/invites`, `POST /me/invites/:code/redeem` | LIFF idToken verify |
| `contract` | `GET/POST/PATCH /c/:slug/contracts` | state machine: draft → active → ended |
| `meter` · `reading` | `GET/POST/PATCH /c/:slug/{meters,readings}` | server-side consumption math |
| `billing` | invoice + payment + slip controllers (admin + `/me/*`) | idempotency, batch, rollup |
| `line` | webhook + channel CRUD | per-tenant HMAC verify |
| `notification` | (no HTTP) — BullMQ producer + worker | invoice issued / payment ok-rejected |
| `storage` | (no HTTP) — R2 client + signed URL generator | shared by slip + reading |
| `health` | `GET /health` | DB + Redis liveness |

---

## Prerequisites

- **Bun ≥ 1.1.30** — install: `curl -fsSL https://bun.sh/install | bash` (see `.bun-version`)
- **Node 20 LTS** (optional fallback) — application code must run on both per ADR-0006
- **Docker** — for local Postgres + Redis (`compose.yml`)
- **LINE Developers account** — LIFF app + Messaging API channel (per company in production; one shared channel works in dev)
- **Cloudflare R2 bucket** — free tier OK

---

## Quickstart

```bash
# 1. Install deps
bun install

# 2. Set up env (no .env.example yet — ask team for the dev template)
cp .env.example .env  # if available; otherwise create .env manually
# Required vars:
#   DATABASE_URL              postgres://dorm:dorm_dev_password@localhost:5432/dorm_dev
#   DATABASE_URL_APP          postgres://dorm_app:dorm_app_password@localhost:5432/dorm_dev
#   REDIS_URL                 redis://localhost:6379
#   JWT_SECRET                ≥ 32 random chars
#   PII_ENCRYPTION_KEY        ≥ 32 random chars (pgcrypto symmetric key)
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
#   LIFF_BIND_URL             https://liff.line.me/{LIFF_ID}
#   LIFF_LOGIN_CHANNEL_ID     numeric LIFF channel id (for idToken `aud` verify)

# 3. Start local infra (Postgres + Redis)
bun run infra:start          # docker compose up -d (project name: dormitory-management-saas)

# 4. Set up DB end-to-end (migrate → apply RLS policies → create dorm_app role → seed)
bun run db:setup
# Equivalent to: db:migrate + db:apply-rls + db:apply-roles + db:seed

# 5. Run all apps in dev mode (parallel via Turborepo)
bun run dev
```

| Surface | URL |
|---------|-----|
| Admin web | http://localhost:3000 |
| API | http://localhost:4000 |
| LIFF (dev) | http://localhost:5173 |

> **First login:** seed creates `easyslip` company + an owner user. Check `packages/db/prisma/seed.ts` for credentials.

---

## Common scripts

| Command | What it does |
| ------- | ------------ |
| `bun run dev` | Run all apps in dev (parallel, via Turborepo) |
| `bun run web` / `api` / `liff` | Run a single app |
| `bun run build` | Build everything |
| `bun run lint` | Biome check (lint + format check) |
| `bun run lint:fix` | Biome check + apply fixes |
| `bun run typecheck` | `tsc --noEmit` across all packages |
| `bun run test` | Vitest across all packages |
| `bun run verify` | Pre-commit gate: lint + bun-api guard + role guard + typecheck + build + shared:test + api test |
| `bun run verify:full` | `verify` + DB reset + DB tests + API e2e |
| `bun run check:bun-api` | Fail-on-`Bun.*` usage guard (ADR-0006 portability) |
| `bun run check:roles` | Fail-on-hard-coded `@Roles` guard (forces matrix-driven RBAC) |
| `bun run e2e:invite` | Generate a test tenant-invite code for LIFF smoke testing |

### Database

| Command | What it does |
| ------- | ------------ |
| `bun run infra:start` / `infra:stop` / `infra:reset` | Docker compose lifecycle |
| `bun run db:setup` | First-time setup: migrate + apply-rls + apply-roles + seed |
| `bun run db:reset` | Nuke + re-setup (DESTROYS DATA) |
| `bun run db:migrate` | Run dev migration (interactive) |
| `bun run db:migrate:reset` | Drop + re-migrate + re-seed |
| `bun run db:studio` | Open Prisma Studio |
| `bun run db:apply-rls` | Re-apply RLS policies (after schema change) |
| `bun run db:apply-roles` | Re-apply Postgres role grants for `dorm_app` |
| `bun run db:seed` | Seed dev companies + sample data |
| `bun run db:setup:test` / `db:reset:test` | Test DB lifecycle (separate database) |

---

## Architecture decisions

See `docs/adr/`:

- ADR-0001 — Monorepo with Turborepo + pnpm *(superseded by 0006 for the runtime/PM)*
- ADR-0002 — Multi-tenant via Row-Level Security
- ADR-0003 — Bring-Your-Own LINE OA (per-tenant credentials)
- ADR-0004 — Path-based routing `/c/{slug}/...`
- ADR-0005 — Money as `Decimal(10,2)`, never `Float`
- ADR-0006 — Bun as Runtime + Package Manager (Node-compatible subset required)

---

## Architecture snapshot

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Admin Web      │     │  LIFF Tenant    │     │  LINE OA        │
│  Next.js 15     │     │  Vite + React   │     │  (per-company)  │
│  /c/{slug}/*    │     │  liff.line.me   │     │  webhook ↓ push │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │ JWT (cookie)          │ JWT (token)           │ HMAC verify
         ▼                       ▼                       ▼
┌────────────────────────────────────────────────────────────────┐
│              API (NestJS + Fastify, port 4000)                 │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌──────────────┐   │
│  │  Auth   │  │ Billing  │  │   LINE    │  │ Notification │   │
│  │  + RBAC │  │ + Slip   │  │  webhook  │  │  + worker    │   │
│  └─────────┘  └──────────┘  └───────────┘  └──────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  TenantContext interceptor → withTenant(companyId, fn)   │  │
│  │  AuditLog interceptor (post-mutation, same tx)           │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────┬─────────────────────┬─────────────────┬──────────────┘
          │                     │                 │
          ▼                     ▼                 ▼
   ┌─────────────┐        ┌─────────┐       ┌──────────┐
   │ Postgres 16 │        │ Redis 7 │       │ R2 (S3)  │
   │  + RLS +    │        │ BullMQ  │       │  private │
   │  pgcrypto   │        │ 4 q's   │       │  bucket  │
   └─────────────┘        └─────────┘       └──────────┘
```

---

## Conventions

- **Branches:** `feat/<short-name>`, `fix/<short-name>`, `chore/<short-name>`
- **Commits:** Conventional Commits with the extended template in CLAUDE.md §6b — every commit includes `RLS impact`, `Audit log`, `Idempotent`, `Node-compatible` checks
- **PR description:** must answer the same four checks
- **Definition of Done:** see CLAUDE.md §6 (DoD checklist)
- **Runtime portability:** no `Bun.*` globals in `apps/**` or `packages/**` (ADR-0006) — enforced by `scripts/check-no-bun-api.mjs`
- **RBAC:** matrix-driven via `@dorm/shared/rbac` + `@Perm()` decorator — hard-coded `@Roles()` is lint-blocked outside an allow-list

---

## What's NOT in MVP (per CLAUDE.md §9)

These are intentionally **out of scope** for the 1-month sprint and will be revisited in Phase 2+:

- AI OCR meter reading · Auto slip verification · Multi-property dashboard
- Smart lock · e-Tax Invoice · Guardian/Student mode · NLP chatbot
- Accounting integrations · Dynamic PromptPay · Late-fee automation
- Unified inbox

---

## Phase 2 backlog (next sprints, not started)

| Cluster | Tickets | Notes |
|---------|---------|-------|
| **Production deploy** | Fly.io (sin) + Neon (sin) + Upstash + R2 + domain + HTTPS | Blocker for beta |
| **Maintenance tickets** | DB + API + LIFF form + Admin Kanban | High tenant touch (P0 per brief) |
| **Receipt PDF + Flex push** | After payment confirm | Legal compliance + UX upgrade |
| **Dashboard KPIs** | Occupancy + MRR + overdue + tickets | Owner visibility |
| **LINE Rich Menu provisioner** | 6-tile menu auto-setup per company | First-touch UX |
| **Self-signup wizard** | Owner onboards new dorm without dev | Scale-out |
| **Cron batch invoice** | Auto-trigger monthly | Reduce admin toil |
| **Move-out + deposit calc** | TEN-004 from brief | Tenant lifecycle close |
| **Broadcast announcement** | LINE multicast composer | Property-wide notices |
| **Polish** | Reading photo upload UI · meter admin UI · `@db.Date` wire serialisation · audit log enhancements · rate limiting · DSR endpoint | Tech debt + Week-4 hardening |

---

## License

Proprietary — Internal Use Only.
