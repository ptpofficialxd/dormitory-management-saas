-- AUTH-004 (Task #111): self-signup wizard placeholders.
--
-- Adds three nullable columns that the signup flow will populate, and that
-- future sprints (SAAS-001..003 + Phase 1 email-verify) will start enforcing.
-- All three are nullable in Prisma so we can iterate the SAAS schema without
-- a backward-incompatible migration; the backfill at the bottom guarantees
-- existing rows get sensible defaults today.
--
-- Why nullable + backfilled (instead of NOT NULL DEFAULT):
--   - keeps the SAAS migration easy to revert if pricing changes
--   - keeps `email_verified_at` semantically "unset" for users that signed
--     up before email verification existed (Phase 1 will distinguish these)

-- CreateEnum
CREATE TYPE "plan" AS ENUM ('free', 'starter', 'pro', 'business');

-- AlterTable: company — add trial + plan placeholders
ALTER TABLE "company" ADD COLUMN     "trial_ends_at" TIMESTAMPTZ(6),
ADD COLUMN     "plan" "plan" DEFAULT 'free';

-- AlterTable: user — add email verification placeholder
ALTER TABLE "user" ADD COLUMN     "email_verified_at" TIMESTAMPTZ(6);

-- Backfill: existing seeded companies get a 14-day trial starting from their
-- createdAt + plan='free'. Done in the same migration so anyone running this
-- on an existing dev DB lands in a consistent state. Idempotent: only updates
-- rows where plan/trial are still null.
UPDATE "company"
SET    "trial_ends_at" = "created_at" + INTERVAL '14 days'
WHERE  "trial_ends_at" IS NULL;

UPDATE "company"
SET    "plan" = 'free'
WHERE  "plan" IS NULL;
