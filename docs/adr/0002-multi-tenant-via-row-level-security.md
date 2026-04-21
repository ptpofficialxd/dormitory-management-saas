# ADR-0002 — Multi-tenant via Row-Level Security (RLS)

- **Status:** Accepted
- **Date:** 2026-04-21

## Context

SaaS must serve multiple dormitory companies from one database without the cost and
operational overhead of schema-per-tenant or DB-per-tenant. At the same time, a single
missed `WHERE company_id = ...` would leak data across tenants — an unacceptable failure
mode for PDPA compliance.

## Decision

**Shared database, shared schema, with PostgreSQL Row-Level Security (RLS)
enforced on every tenant-owned table**, starting Day-1.

Mechanism:

1. Every tenant-owned table has `company_id UUID NOT NULL`.
2. RLS enabled on that table:
   ```sql
   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON <t>
     USING (company_id = current_setting('app.company_id')::uuid);
   ```
3. API layer sets the session variable at the start of every transaction:
   ```sql
   SET LOCAL app.company_id = '<uuid-from-jwt>';
   ```
4. A Prisma middleware wraps every query in a transaction and sets `app.company_id`
   from the authenticated request context.
5. CI runs an **isolation test** that seeds two companies and asserts no cross-read.

## Rationale

- RLS is a database-enforced safety net. Application bugs still can't leak data.
- Cost and migration complexity stay linear (1 DB, 1 schema).
- Analytics queries across all tenants remain trivial (with `SET LOCAL` bypass by super_admin).

## Alternatives considered

- **App-layer filter only** — one missed `WHERE` = breach. Rejected.
- **Schema-per-tenant** — `N × migrations`, connection-pool pain. Overkill for MVP.
- **DB-per-tenant** — cost and ops explode. Reserved for enterprise VIP only.

## Consequences

- Prisma's raw SQL (`$queryRaw`) needs review — it still obeys RLS but devs must
  not accidentally run as a super_admin role.
- Seed scripts and internal jobs must either set `app.company_id` or run as a role
  that bypasses RLS.
- Backup/restore and `pg_dump --data-only` behave normally.
