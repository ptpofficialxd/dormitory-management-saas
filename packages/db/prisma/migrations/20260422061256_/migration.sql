-- CreateTable
CREATE TABLE "company_line_channel" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "channel_id" VARCHAR(32) NOT NULL,
    "channel_secret" VARCHAR(512) NOT NULL,
    "channel_access_token" VARCHAR(2048) NOT NULL,
    "basic_id" VARCHAR(64),
    "display_name" VARCHAR(128),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "company_line_channel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_line_channel_company_id_key" ON "company_line_channel"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_line_channel_channel_id_key" ON "company_line_channel"("channel_id");

-- CreateIndex
CREATE INDEX "company_line_channel_company_id_idx" ON "company_line_channel"("company_id");

-- AddForeignKey
ALTER TABLE "company_line_channel" ADD CONSTRAINT "company_line_channel_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
