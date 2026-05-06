-- CreateEnum
CREATE TYPE "announcement_status" AS ENUM ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "announcement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "title" VARCHAR(128) NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "target" JSONB NOT NULL,
    "status" "announcement_status" NOT NULL DEFAULT 'draft',
    "scheduled_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "delivered_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "announcement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcement_company_id_created_at_idx" ON "announcement"("company_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "announcement_company_id_status_idx" ON "announcement"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_company_id_idempotency_key_key" ON "announcement"("company_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
