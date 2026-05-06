-- Task #116: relax DB-level audit_log append-only enforcement.
--
-- Why: the BEFORE UPDATE/DELETE triggers + Restrict FK on company made it
-- impossible to delete a Company/User through Prisma Studio (or any other
-- runtime tool that doesn't run as superuser with `session_replication_role
-- = 'replica'`). The append-only contract is preserved at the APPLICATION
-- layer instead, via:
--   1. Code review + CLAUDE.md §3.7 (now reframed as "service code MUST NOT
--      issue prisma.auditLog.update*/delete*").
--   2. `scripts/check-no-audit-mutation.mjs` lint check, run as part of the
--      `verify` pipeline. Catches accidental regressions at PR time.
--
-- Trade-off: defense-in-depth at the DB layer is gone. Bug-introduced
-- audit_log mutation (e.g. a service hooked the wrong table) would no
-- longer raise immediately — would surface in code review or post-incident
-- audit. Acceptable because (a) audit_log mutations are extremely rare
-- code paths to add, (b) Studio convenience matters for solo-dev MVP
-- velocity, (c) lint catches the easy ones.

-- Drop the triggers first, then the function (PostgreSQL needs both
-- triggers gone before the function can be dropped without CASCADE).
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
DROP FUNCTION IF EXISTS audit_log_deny_mutation();

-- Change audit_log→company FK from Restrict to Cascade so deleting a
-- Company through any client (Studio, manual SQL, GDPR erasure script)
-- automatically purges its audit rows. The actor relation stays SetNull
-- (deleting a User keeps the audit row; the actor is just nulled out).
ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_company_id_fkey";

ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
