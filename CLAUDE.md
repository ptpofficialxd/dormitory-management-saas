# CLAUDE.md — AI Assistant Context

This file is loaded by AI coding assistants (Cursor, Claude Code, etc.) when working in this repo.
**Treat this as the operating contract for any AI-assisted change.**

---

## 1. Project

**Dormitory / Apartment Management SaaS (Thailand)** — LINE-first multi-tenant SaaS.

Three product surfaces:

- `apps/web-admin` — Next.js admin dashboard (owner/manager/staff)
- `apps/liff-tenant` — Vite+React LIFF app inside LINE OA (tenant-facing)
- `apps/api` — NestJS + Fastify backend

Target: ship a real working MVP for **one real dormitory (~40 rooms)** in **1 month**.

---

## 2. Stack (locked — do not change without an ADR)

| Layer              | Tool                                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| Runtime + PM       | **Bun 1.1.x** (runtime + package manager + workspaces). See ADR-0006.         |
| Monorepo orchestr. | Turborepo 2.x (cache + task graph)                                            |
| Admin Web          | Next.js 15 App Router + TypeScript + Tailwind + shadcn/ui                     |
| LIFF Tenant        | Vite + React + TypeScript + Tailwind                                          |
| API                | NestJS + Fastify adapter                                                      |
| DB                 | PostgreSQL 16 + Prisma (source of truth, `engineType = "library"`)            |
| Cache/Queue        | Redis + BullMQ (via `ioredis`)                                                |
| Storage            | Cloudflare R2 (S3-compatible)                                                 |
| Auth               | Admin: JWT + email/password. Tenant: LINE Login (LIFF).                       |
| Validation         | Zod (shared schemas in `packages/shared`)                                     |
| Lint/Format        | Biome (single tool, replaces ESLint + Prettier)                               |
| Test               | Vitest (unit + integration) — **not `bun test`** (portability). Hosted under Node via `scripts/vitest.mjs` wrapper, see ⚠ below |
| CI                 | GitHub Actions + `oven-sh/setup-bun@v2`                                       |

**Forbidden without ADR:** swapping Prisma, swapping NestJS, adding GraphQL,
adding a second language runtime, adding Kubernetes, swapping Bun → Node.

**Runtime portability rule (ADR-0006):** application code must run on **both**
Bun and Node. No `Bun.*` globals in `apps/**` or `packages/**`. Wrap any
runtime-specific API behind an adapter with a Node fallback. Use Node built-ins
(`node:crypto`, `node:fs/promises`, `node:path`) — not `Bun.file` / `Bun.password`.

**⚠ Vitest under Node (not Bun):** Bun 1.3.x cannot host vitest workers
(`port.addListener` missing on its `node:worker_threads` MessagePort polyfill;
both `pool: 'threads'` and `pool: 'forks'` fail because Bun's `child_process.fork`
spawns Bun, not Node). Bun 1.3.x ALSO auto-substitutes `node` → `bun` in
package.json script commands, defeating naive workarounds. All test scripts
(`packages/shared`, `packages/db`, `apps/api`) route through `scripts/vitest.mjs`
— a Node wrapper that detects Bun runtime, locates a real Node binary in PATH,
and re-execs itself there. Don't write `vitest --run` directly in package.json
test scripts; always use `node ../../scripts/vitest.mjs --run`. The wrapper
works on both Bun 1.1.x (`packageManager` pin) and 1.3.x (latest installs), so
team members don't need to coordinate Bun versions.

---

## 3. Non-negotiable Architecture Rules

1. **Multi-tenant by default.** Every tenant-owned table has `companyId UUID NOT NULL`.
2. **Row-Level Security (RLS) prepared from Day-1.** Every query filtered by `companyId`
   via Postgres session variable `app.company_id`, set in a Prisma middleware at request boundary.
3. **Money is `Decimal(10,2)`** (`@db.Decimal(10,2)` in Prisma). Never `Float`/`number` for currency.
4. **Time: store UTC, display `Asia/Bangkok`.** Use `date-fns-tz`.
5. **Path-based routing `/c/{companySlug}/...`** — no subdomains in MVP.
6. **LIFF is mobile-first (≥375px). Admin Web is responsive (≥375px).**
7. **Audit log is append-only** (required on every mutation touching PII or money). Service code MUST NOT call `prisma.auditLog.update*` / `delete*` / `upsert` — only test files (`*.test.ts`, `*.e2e-test.ts`) may, for cleanup. Enforced by `scripts/check-no-audit-mutation.mjs` in the `verify` pipeline. DB-level triggers were dropped in migration `20260506110000` so Prisma Studio + GDPR erasure can cascade-delete a Company; the contract now lives in code review + lint.
8. **PII at rest is encrypted** (`national_id`, `phone`, `bank_account`) via pgcrypto.
9. **ID card images** go to R2 **private** bucket + signed URL TTL ≤ 5 minutes.
10. **Idempotency** on: LINE webhook, slip upload, payment confirm. Use `Idempotency-Key`
    header + unique DB constraint.
11. **LINE webhook verifies `X-Line-Signature` HMAC-SHA256** using per-tenant channel secret
    **before** doing any work.
12. **Prisma schema is the single source of truth.** Types flow from Prisma → shared → apps.
13. **RBAC is table-driven** (5 roles: `company_owner`, `property_manager`, `staff`, `tenant`,
    `guardian`). Never hard-code role checks.
14. **Thai locale default:** `th-TH`, currency `THB`.

---

## 4. Domain Glossary (ไทย ↔ English)

Use these exact terms in code (camelCase for TS, snake_case in DB).

| Thai              | English / Code                  | Notes                                                   |
| ----------------- | ------------------------------- | ------------------------------------------------------- |
| บริษัท / หอ (SaaS tenant) | `company`                       | Top-level tenant in multi-tenant model                  |
| โครงการ / ตึก     | `property`                      | A building/site owned by a company                      |
| ชั้น              | `floor`                         | Floor within a property                                 |
| ห้อง / ยูนิต      | `unit`                          | A rentable room                                         |
| ประเภทห้อง        | `unitType`                      | Room type + base price + size                           |
| ผู้เช่า           | `tenant`                        | Person renting a unit (LIFF user)                       |
| ผู้ปกครอง         | `guardian`                      | For student housing (Phase 2)                           |
| สัญญา             | `contract`                      | Rental contract, has start/end, rent, deposit           |
| เงินประกัน        | `deposit` / `depositLedger`     | Held until move-out                                     |
| มิเตอร์           | `meter`                         | Water or electricity meter per unit                     |
| ค่ามิเตอร์        | `reading`                       | A single meter read (value + period + photo)            |
| รอบบิล            | `period` (e.g. `"2026-04"`)     | Billing period, always YYYY-MM                          |
| บิล / ใบแจ้งหนี้  | `invoice`                       | Monthly bill                                            |
| รายการในบิล       | `invoiceItem`                   | Line item (rent, water, electric, common, misc)         |
| ยอดรวม            | `total`                         | `Decimal(10,2)`                                          |
| การชำระ           | `payment`                       | A paid amount against an invoice                        |
| สลิป              | `slip`                          | Payment proof image uploaded by tenant                  |
| PromptPay QR      | `promptPayRef` / `promptPayQr`  | Static QR per invoice in MVP                            |
| ค่าปรับล่าช้า     | `lateFee`                       | Phase 1                                                 |
| ใบเสร็จ           | `receipt`                       | PDF after payment confirmed                             |
| แจ้งซ่อม          | `maintenanceRequest` / `ticket` |                                                         |
| ประกาศ            | `announcement` / `broadcast`    | Sent via LINE push                                      |
| บันทึกกิจกรรม     | `auditLog`                      | Append-only                                             |

---

## 5. Per-Feature Workflow (follow every time)

1. **Prisma schema first** — edit `packages/db/prisma/schema.prisma`, run migrate.
2. **Zod schema in `packages/shared`** — request/response contracts.
3. **NestJS module**: `feature.module.ts` → `controller` → `service` → `dto` (Zod-derived).
4. **Guards** for auth, **Interceptors** for audit log, **Pipes** for validation.
5. **Unit test** the service (billing math, RLS, idempotency).
6. **Integration test** the API endpoint (with 2 seeded companies, assert isolation).
7. **Frontend**: page → `react-hook-form` + `zodResolver` + `TanStack Query` mutation.

---

## 6. Definition of Done (apply to every PR)

- [ ] `bun run verify` clean (lint + bun-api-guard + typecheck + shared test + api test + build)
- [ ] Unit tests added for new domain logic (≥70% on billing/auth/audit)
- [ ] **Isolation test**: RLS verified with 2 companies on any new tenant-owned table
- [ ] Audit log emitted for any mutation on PII/money
- [ ] All strings via i18n key (th-TH default); no hard-coded Thai in components
- [ ] Mobile-responsive ≥ 375px (if UI)
- [ ] PR description answers: **RLS impact? Audit log? Idempotent?**
- [ ] Commit message follows §6b template

### 6b. Commit Message Template (Conventional Commits — required)

Every commit MUST use this structure:

```
<type>(<scope>): <imperative short summary> (Task #N)

<short paragraph อธิบายว่าทำอะไร / ทำไม>

Changes:
- <bullet ของไฟล์/feature ที่แก้>
- <bullet ที่ 2>

PR Checks:
- RLS impact: <yes — policy added on table X / no — admin-only / N/A>
- Audit log: <yes — emitted on mutations of X / no — read-only>
- Idempotent: <yes — key: X / no — N/A>
- Node-compatible: <yes — no Bun.* / N/A>

Refs: ADR-XXXX, Task #N
```

**Rules:**

| Field | Rule |
| --- | --- |
| `<type>` | `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `style` |
| `<scope>` | Package/module (e.g. `api`, `db`, `shared`, `billing`, `line`, `build`). Multiple OK: `fix(lint,typecheck): ...` |
| Subject | Imperative mood, lowercase, ≤72 chars, no period |
| Body | Wrap ~72 chars, use bullets |
| `BREAKING CHANGE:` footer | Required for DB migration that isn't backward-compatible |
| `Refs` footer | Link to ADR (if applicable) + Task # — always |

---

## 7. Security — things that can get us pwned

Treat these as **hand-written, AI-reviewed, never blindly accepted from AI**:

- Auth guards / JWT verification
- RLS policy SQL
- LINE webhook signature verification
- Slip upload path (never trust client MIME; re-check magic bytes)
- Signed URL generation for R2
- Any raw SQL (`$queryRaw`) — justify in PR
- PDPA consent + DSR endpoints
- Deposit refund calculation

If AI generates code in any of the above, **read every line**.

---

## 8. What NOT to do

- ❌ Float for money
- ❌ Skipping `companyId` filter "just this once"
- ❌ Hard-coding role checks (`if (user.role === 'owner')`)
- ❌ Subdomain routing (path-based only)
- ❌ Deprecated LIFF v1 APIs (use LIFF v2+)
- ❌ Committing `.env`
- ❌ Putting ID card / slip images in public R2 bucket
- ❌ Implementing AI OCR, auto slip verify, smart lock, e-Tax in MVP (out of scope)
- ❌ Creating "generic" abstractions before there are 3+ concrete use cases

---

## 9. Out-of-scope for Month-1 MVP

AI OCR meter · Auto slip verification · Multi-property dashboard · Smart lock ·
e-Tax Invoice · Guardian/Student mode · NLP chatbot · Accounting integrations ·
Dynamic PromptPay · Late-fee automation · Unified inbox
