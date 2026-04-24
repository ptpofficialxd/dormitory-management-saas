-- Partial unique index for (contract_id, period) excluding voided invoices.
--
-- WHY:
--   The original `invoice_contract_id_period_key` unique constraint blocked
--   admin from regenerating an invoice for a (contract, period) tuple after
--   they voided the prior one — the void row kept the slot. Forced workaround
--   was hand-deletion, which destroys the audit trail.
--
--   Partial unique indexes are a Postgres feature; Prisma 6's schema DSL
--   doesn't model them yet, so we manage this constraint via raw SQL here +
--   a regular composite index in the Prisma schema (see Invoice model).
--
-- BEHAVIOUR AFTER MIGRATION:
--   - Two `void` invoices for the same (contract, period)?  → allowed
--   - One `void` + one `draft|issued|partially_paid|paid`?   → allowed
--   - Two `non-void` invoices for the same (contract, period)? → BLOCKED (P2002)
--
-- Race-window note: the existing service-layer P2002 catch in
-- `InvoiceService.createBatch` still fires when a concurrent insert wins
-- the partial unique race; the only behavioural change is that voided rows
-- no longer trigger the catch.

-- Step 1: drop the original full-coverage unique index Prisma generated.
DROP INDEX IF EXISTS "invoice_contract_id_period_key";

-- Step 2: regular composite index for general lookups
-- (matches the new `@@index([contractId, period])` in schema.prisma).
-- Idempotent so re-running locally / in CI doesn't error.
CREATE INDEX IF NOT EXISTS "invoice_contract_id_period_idx"
  ON "invoice"("contract_id", "period");

-- Step 3: partial unique index — the actual constraint.
-- The predicate compares enum-to-enum (`status <> 'void'::invoice_status`)
-- because Postgres requires partial-index predicates to be IMMUTABLE.
-- Casting the column to text (`status::text <> 'void'`) makes the
-- expression STABLE, not IMMUTABLE, and the migration is rejected with:
--   ERROR: functions in index predicate must be marked IMMUTABLE
-- The reverse — casting the literal to enum — is IMMUTABLE because enum
-- comparison is by ordinal lookup which never depends on session state.
CREATE UNIQUE INDEX "invoice_contract_id_period_active_uq"
  ON "invoice"("contract_id", "period")
  WHERE "status" <> 'void'::invoice_status;
