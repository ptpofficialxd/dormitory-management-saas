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

-- ==== tenant =============================================================
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenant;
CREATE POLICY tenant_isolation ON tenant
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== contract ===========================================================
ALTER TABLE contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON contract;
CREATE POLICY tenant_isolation ON contract
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== meter ==============================================================
ALTER TABLE meter ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON meter;
CREATE POLICY tenant_isolation ON meter
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== reading ============================================================
ALTER TABLE reading ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON reading;
CREATE POLICY tenant_isolation ON reading
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== invoice ============================================================
ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON invoice;
CREATE POLICY tenant_isolation ON invoice
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== invoice_item =======================================================
ALTER TABLE invoice_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_item FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON invoice_item;
CREATE POLICY tenant_isolation ON invoice_item
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== payment ============================================================
ALTER TABLE payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON payment;
CREATE POLICY tenant_isolation ON payment
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== slip ===============================================================
ALTER TABLE slip ENABLE ROW LEVEL SECURITY;
ALTER TABLE slip FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON slip;
CREATE POLICY tenant_isolation ON slip
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== company_line_channel ===============================================
-- Lookup-by-channelId at webhook entry MUST use `bypassRls: true` because
-- there is no tenant context yet (LINE servers don't carry our JWT). Once
-- the lookup resolves the companyId, the rest of the request runs under
-- normal RLS scope.
ALTER TABLE company_line_channel ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_line_channel FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON company_line_channel;
CREATE POLICY tenant_isolation ON company_line_channel
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== tenant_invite ======================================================
-- Admin endpoints (generate / revoke / list) run inside withTenant({companyId})
-- so the standard policy fires and scopes by company_id.
--
-- Public LIFF endpoints (peek / redeem) have NO tenant context at request
-- entry — the LIFF user types a code, the server has to look it up by
-- code_prefix BEFORE it knows which company. That single read uses
-- `bypassRls: true` (deliberately narrow scope: SELECT WHERE code_prefix = …
-- AND status = 'pending'), then the response handler SWITCHES into
-- withTenant({companyId}) using the row's company_id for the actual mutate
-- (CAS status flip + tenant.line_user_id update + audit_log INSERT). So the
-- standard policy below covers admin + the post-resolve mutate path; the
-- bypass branch covers the pre-resolve lookup + ops scripts.
ALTER TABLE tenant_invite ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_invite FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenant_invite;
CREATE POLICY tenant_isolation ON tenant_invite
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== webhook_event ======================================================
-- Webhook controller resolves channelId → companyId via the bypass-RLS
-- CompanyLineChannel lookup, then SWITCHES into withTenant({companyId}) for
-- the webhook_event INSERT. So under normal flow `app.company_id` is
-- already set when this policy fires — no need to bypass RLS for the
-- INSERT itself. Worker side: the BullMQ processor re-opens
-- withTenant({companyId}) from the job payload before reading/updating the
-- row, so RLS scopes the worker's writes the same way as any other
-- service. `app_rls_bypass()` stays in the policy for ops/maintenance
-- scripts that need to scan webhook_event across tenants (replay buffer
-- diagnostics).
ALTER TABLE webhook_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_event FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON webhook_event;
CREATE POLICY tenant_isolation ON webhook_event
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== maintenance_request ================================================
-- Sprint B / Task #87. Both admin (web-admin /c/:slug/maintenance) and tenant
-- (LIFF /me/maintenance) paths run inside `withTenant({ companyId })` so the
-- standard policy fires. Tenant scope is further narrowed at the service
-- layer (`tenantId = req.user.sub`) — RLS handles cross-company isolation;
-- service handles cross-tenant-within-company isolation.
ALTER TABLE maintenance_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_request FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON maintenance_request;
CREATE POLICY tenant_isolation ON maintenance_request
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- ==== announcement =======================================================
-- COM-003 / Task #105. Admin path runs inside withTenant({companyId}) for
-- create + read. Worker path (LineNotificationProcessor) re-opens
-- withTenant({ companyId }) from the job payload before incrementing the
-- delivered/failed counters, so the worker's writes scope correctly. No
-- tenant LIFF surface in v1 — push-only delivery; LIFF history page is
-- deferred to Phase 1 per the COM-003 plan.
ALTER TABLE announcement ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcement FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON announcement;
CREATE POLICY tenant_isolation ON announcement
  USING (app_rls_bypass() OR company_id = app_current_company_id())
  WITH CHECK (app_rls_bypass() OR company_id = app_current_company_id());

-- -------------------------------------------------------------------------
-- Append-only enforcement for audit_log (CLAUDE.md §3.7).
--
-- DB-level triggers were REMOVED in migration 20260506110000 to let
-- Prisma Studio + GDPR erasure scripts delete Company/User rows without
-- requiring superuser + session_replication_role. Append-only is now
-- enforced at the APPLICATION layer:
--   • Service code MUST NOT issue prisma.auditLog.update*/delete*.
--   • Lint check `scripts/check-no-audit-mutation.mjs` runs in CI/verify
--     and fails the build on regressions.
--
-- We still drop any triggers + function the legacy migration left behind,
-- so an apply-rls run on a freshly-migrated DB ends up consistent with a
-- DB that ran the new migration.
-- -------------------------------------------------------------------------
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
DROP FUNCTION IF EXISTS audit_log_deny_mutation();

COMMIT;
