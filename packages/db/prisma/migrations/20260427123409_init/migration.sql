-- CreateEnum
CREATE TYPE "maintenance_status" AS ENUM ('open', 'in_progress', 'resolved', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "maintenance_priority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "maintenance_category" AS ENUM ('plumbing', 'electrical', 'aircon', 'appliance', 'furniture', 'structural', 'internet', 'other');

-- CreateTable
CREATE TABLE "maintenance_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category" "maintenance_category" NOT NULL,
    "title" VARCHAR(128) NOT NULL,
    "description" VARCHAR(2048) NOT NULL,
    "priority" "maintenance_priority" NOT NULL DEFAULT 'normal',
    "status" "maintenance_status" NOT NULL DEFAULT 'open',
    "photo_r2_keys" VARCHAR(512)[],
    "assigned_to_user_id" UUID,
    "resolution_note" VARCHAR(2048),
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "maintenance_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "maintenance_request_company_id_status_idx" ON "maintenance_request"("company_id", "status");

-- CreateIndex
CREATE INDEX "maintenance_request_company_id_created_at_idx" ON "maintenance_request"("company_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "maintenance_request_tenant_id_created_at_idx" ON "maintenance_request"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "maintenance_request_assigned_to_user_id_idx" ON "maintenance_request"("assigned_to_user_id");

-- CreateIndex
CREATE INDEX "maintenance_request_unit_id_idx" ON "maintenance_request"("unit_id");

-- AddForeignKey
ALTER TABLE "maintenance_request" ADD CONSTRAINT "maintenance_request_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_request" ADD CONSTRAINT "maintenance_request_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_request" ADD CONSTRAINT "maintenance_request_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_request" ADD CONSTRAINT "maintenance_request_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
