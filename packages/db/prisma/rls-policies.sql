-- =========================================================================
-- Row-Level Security policies for Dorm SaaS
-- =========================================================================
-- Run via: bun run apply-rls  (after `prisma migrate deploy`)
--
-- Mechanism (ADR-0002):
--   * App boundary sets a transaction-local Postgres setting:
--         SELECT set_config('app.company_id', '<uuid>', true);
--     ...and every query runs INSIDE that same transaction.
--   * Every policy checks either:
--         a) company_id = current_setting('app.company_id', TRUE)::uuid
--      OR b) current_setting('app.bypass_rls', TRUE) = 'true'
--            (used by seed scripts and platform super_admin tools)
--   * FORCE ROW LEVEL SECURITY applies the policy even to the table owner.
--     Without FORCE, the owner bypasses RLS silently — UNACCEPTABLE.
--
-- This script is idempotent: safe to re-run after schema changes.
-- Every new tenant-scoped table MUST be added to the TENANT_TABLES list below.
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- Helper function — returns TRUE if the current session is a bypass caller.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_rls_bypass() RETURNS boolean
LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.bypass_rls', TRUE), 'false') = 'true' $$;

-- -------------------------------------------------------------------------
-- Helper function — returns the current tenant's company_id (or NULL).
-- NULL forces default-deny in policies.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_company_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS
$$
DECLARE
  v text := current_setting('app.company_id', TRUE);
BEGIN
  IF v IS NULL OR v = '' THEN
    RETURN NULL;
  END IF;
  RETURN v::uuid;
END;
$$;

-- -------------------------------------------------------------------------
-- Apply RLS + policies to every tenant-scoped table.
-- The `company` table uses `id` (it IS the tenant row itself);
-- all other tables use `company_id` FK.
-- -------------------------------------------------------------------------

-- ==== company ============================================================
ALTER TABLE company ENABLE ROW LEVEL SECURITY;
ALTER TABLE company FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON company;
CREATE POLICY tenant_isolation ON company
  USING (app_rls_bypass() OR id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR id = app_current_company_id());

-- ==== user ===============================================================
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "user";
CREATE POLICY tenant_isolation ON "user"
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== role_assignment ====================================================
ALTER TABLE role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignment FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON role_assignment;
CREATE POLICY tenant_isolation ON role_assignment
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== property ===========================================================
ALTER TABLE property ENABLE ROW LEVEL SECURITY;
ALTER TABLE property FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON property;
CREATE POLICY tenant_isolation ON property
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== unit ===============================================================
ALTER TABLE unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON unit;
CREATE POLICY tenant_isolation ON unit
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== audit_log ==========================================================
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON audit_log;
CREATE POLICY tenant_isolation ON audit_log
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- -------------------------------------------------------------------------
-- Append-only enforcement for audit_log (CLAUDE.md §3.7).
-- UPDATE / DELETE are denied even by the bypass role.
-- TRUNCATE is still possible via SUPERUSER (intentional — DB-level ops).
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_deny_mutation();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_deny_mutation();

COMMIT;
