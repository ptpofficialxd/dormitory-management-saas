-- CreateEnum
CREATE TYPE "tenant_invite_status" AS ENUM ('pending', 'redeemed', 'expired', 'revoked');

-- CreateTable
CREATE TABLE "tenant_invite" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "code_prefix" CHAR(4) NOT NULL,
    "status" "tenant_invite_status" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "redeemed_at" TIMESTAMPTZ(6),
    "redeemed_by_line_user_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID NOT NULL,

    CONSTRAINT "tenant_invite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_invite_company_id_status_created_at_idx" ON "tenant_invite"("company_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "tenant_invite_tenant_id_idx" ON "tenant_invite"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_invite_code_prefix_status_idx" ON "tenant_invite"("code_prefix", "status");

-- AddForeignKey
ALTER TABLE "tenant_invite" ADD CONSTRAINT "tenant_invite_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_invite" ADD CONSTRAINT "tenant_invite_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_invite" ADD CONSTRAINT "tenant_invite_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
