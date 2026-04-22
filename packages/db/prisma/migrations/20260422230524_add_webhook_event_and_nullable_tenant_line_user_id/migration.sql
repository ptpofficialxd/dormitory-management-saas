-- =========================================================================
-- Task #37 — WebhookEvent table + Tenant.lineUserId nullable
-- =========================================================================
-- 1. Tenant.lineUserId becomes NULLable so admins can pre-create a tenant
--    record before the human ever opens the LIFF app. The binding happens
--    later via the TenantInvite flow (Task #41).
--    The existing UNIQUE index `(company_id, line_user_id)` stays AS-IS
--    because Postgres treats multiple NULLs as DISTINCT in unique indexes
--    (default semantics, not `NULLS NOT DISTINCT`). So unbound tenants do
--    not collide with each other while still blocking two tenants from
--    binding the same LINE userId within one company.
-- 2. WebhookEvent — append-once log for inbound LINE deliveries. Powers
--    Postgres-only dedup (`(company_id, event_id)` unique) + BullMQ job
--    audit trail.  RLS is applied via rls-policies.sql (re-run after
--    `prisma migrate deploy`).
-- =========================================================================

-- CreateEnum
CREATE TYPE "webhook_event_status" AS ENUM ('pending', 'processing', 'processed', 'failed');

-- AlterTable
ALTER TABLE "tenant" ALTER COLUMN "line_user_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "webhook_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "event_id" VARCHAR(64) NOT NULL,
    "event_type" VARCHAR(32) NOT NULL,
    "channel_id" VARCHAR(32) NOT NULL,
    "line_user_id" VARCHAR(64),
    "payload" JSONB NOT NULL,
    "event_timestamp" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "webhook_event_status" NOT NULL DEFAULT 'pending',
    "processed_at" TIMESTAMPTZ(6),
    "processing_error" VARCHAR(1024),
    "retry_count" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_event_company_event_unique" ON "webhook_event"("company_id", "event_id");

-- CreateIndex
CREATE INDEX "webhook_event_company_id_status_received_at_idx" ON "webhook_event"("company_id", "status", "received_at");

-- CreateIndex
CREATE INDEX "webhook_event_channel_id_idx" ON "webhook_event"("channel_id");

-- AddForeignKey
ALTER TABLE "webhook_event" ADD CONSTRAINT "webhook_event_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
