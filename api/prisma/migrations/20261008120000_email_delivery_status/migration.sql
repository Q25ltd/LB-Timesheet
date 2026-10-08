-- D56: application-level email delivery status for SES hard bounces and
-- complaints. Additive only: three new tables and their enums; no existing
-- table, column or row is touched.

-- CreateEnum
CREATE TYPE "EmailSender" AS ENUM ('accounts', 'security', 'timesheets');

-- CreateEnum
CREATE TYPE "EmailDeliveryEventKind" AS ENUM ('hard_bounce', 'transient_bounce', 'complaint');

-- CreateEnum
CREATE TYPE "EmailSuppressionReason" AS ENUM ('hard_bounce', 'complaint');

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "sesMessageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sender" "EmailSender" NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDeliveryEvent" (
    "id" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "kind" "EmailDeliveryEventKind" NOT NULL,
    "detail" TEXT,
    "emailMessageId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailDeliveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "email" CITEXT NOT NULL,
    "reason" "EmailSuppressionReason" NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("email","reason")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_sesMessageId_key" ON "EmailMessage"("sesMessageId");

-- CreateIndex
CREATE INDEX "EmailMessage_userId_idx" ON "EmailMessage"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDeliveryEvent_feedbackId_key" ON "EmailDeliveryEvent"("feedbackId");

-- CreateIndex
CREATE INDEX "EmailDeliveryEvent_emailMessageId_idx" ON "EmailDeliveryEvent"("emailMessageId");

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDeliveryEvent" ADD CONSTRAINT "EmailDeliveryEvent_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An SES detail string is a short code ("General", "abuse"); bounded so the
-- column can never become a place a message body lands (D56: no content).
ALTER TABLE "EmailDeliveryEvent" ADD CONSTRAINT "EmailDeliveryEvent_detail_bounded" CHECK ("detail" IS NULL OR length("detail") <= 64);
