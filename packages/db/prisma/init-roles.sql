-- =========================================================================
-- Application role (non-privileged) for runtime Prisma queries.
-- =========================================================================
-- Why a separate role?
--   The default `dorm` role is a SUPERUSER (Docker postgres default) AND has
--   BYPASSRLS — meaning RLS policies are silently ignored. `FORCE ROW LEVEL
--   SECURITY` does NOT cover SUPERUSER / BYPASSRLS roles.
--
--   Runtime queries MUST run under a role that has NEITHER attribute, so RLS
--   actually enforces tenant isolation. Migrations still run under `dorm`
--   (needs CREATE privilege).
--
-- Idempotent: safe to re-run. Password is read from PSQL var `:'app_pw'`.
--   psql -v app_pw='s3cret' -f init-roles.sql
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- 1. Create or update the app role.
-- -------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dorm_app') THEN
    EXECUTE format(
      'CREATE ROLE dorm_app WITH LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT',
      current_setting('app_pw')
    );
  ELSE
    -- Refresh password + enforce attributes on re-run.
    EXECUTE format(
      'ALTER ROLE dorm_app WITH LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT',
      current_setting('app_pw')
    );
  END IF;
END
$$;

-- -------------------------------------------------------------------------
-- 2. Connect + schema usage.
-- -------------------------------------------------------------------------
GRANT CONNECT ON DATABASE dorm_test TO dorm_app;
GRANT USAGE ON SCHEMA public TO dorm_app;

-- -------------------------------------------------------------------------
-- 3. CRUD on existing tables + sequences.
--    (Tables created by `prisma migrate` before this script runs.)
-- -------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO dorm_app;
GRANT USAGE, SELECT                 ON ALL SEQUENCES IN SCHEMA public TO dorm_app;

-- -------------------------------------------------------------------------
-- 4. Default privileges for FUTURE tables/sequences created by `dorm`
--    during later migrations. Without this, every new migration would need
--    a manual GRANT.
-- -------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE dorm IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dorm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE dorm IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dorm_app;

-- -------------------------------------------------------------------------
-- 5. Execute rights on the RLS helper functions.
--    (STABLE SQL/PLPGSQL functions are callable by default, but be explicit.)
-- -------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION app_rls_bypass()         TO dorm_app;
GRANT EXECUTE ON FUNCTION app_current_company_id() TO dorm_app;

COMMIT;

-- -------------------------------------------------------------------------
-- 6. Verification (informational — does not fail the script).
-- -------------------------------------------------------------------------
SELECT usename, usesuper, usebypassrls, usecreatedb
FROM pg_user
WHERE usename IN ('dorm', 'dorm_app')
ORDER BY usename;
