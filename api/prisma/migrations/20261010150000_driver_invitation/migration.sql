-- D63, stage 1: a company's invitation of a driver, by email address.
--
-- ADDITIVE ONLY: a new enum, a new table and its constraints. No existing
-- table, column or row is read, changed or removed.

-- CreateEnum
CREATE TYPE "DriverInvitationStatus" AS ENUM ('pending', 'cancelled', 'expired');

-- CreateTable
CREATE TABLE "DriverInvitation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "payrollRef" TEXT,
    "status" "DriverInvitationStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "emailSentAt" TIMESTAMP(3),
    "sesMessageId" TEXT,

    CONSTRAINT "DriverInvitation_pkey" PRIMARY KEY ("id"),

    -- The names as the company typed them, already trimmed: 1–200 characters,
    -- not starting or ending with whitespace. `[:space:]` is PostgreSQL's
    -- whitespace class; the application trims with JavaScript's broader rule.
    CONSTRAINT "DriverInvitation_first_name_trimmed" CHECK ("firstName" ~ '^[^[:space:]](.*[^[:space:]])?$'),
    CONSTRAINT "DriverInvitation_first_name_length" CHECK (char_length("firstName") <= 200),
    CONSTRAINT "DriverInvitation_last_name_trimmed" CHECK ("lastName" ~ '^[^[:space:]](.*[^[:space:]])?$'),
    CONSTRAINT "DriverInvitation_last_name_length" CHECK (char_length("lastName") <= 200),

    -- Absent is NULL, never an empty string; present is trimmed, at most 64.
    CONSTRAINT "DriverInvitation_payroll_ref_trimmed" CHECK ("payrollRef" IS NULL OR "payrollRef" ~ '^[^[:space:]](.*[^[:space:]])?$'),
    CONSTRAINT "DriverInvitation_payroll_ref_length" CHECK ("payrollRef" IS NULL OR char_length("payrollRef") <= 64),

    CONSTRAINT "DriverInvitation_email_length" CHECK (char_length("email") BETWEEN 3 AND 320),
    CONSTRAINT "DriverInvitation_expires_after_creation" CHECK ("expiresAt" > "createdAt")
);

-- The company's list, newest first, and its 24-hour cap.
CREATE INDEX "DriverInvitation_companyId_createdAt_idx" ON "DriverInvitation"("companyId", "createdAt");

-- The per-address cap across companies, and (stage 3) a verified driver's invitations.
CREATE INDEX "DriverInvitation_email_createdAt_idx" ON "DriverInvitation"("email", "createdAt");

CREATE UNIQUE INDEX "DriverInvitation_sesMessageId_key" ON "DriverInvitation"("sesMessageId");

-- ONE open invitation per company and address (D63). Case-insensitive by
-- citext. A cancelled or expired one does not count.
CREATE UNIQUE INDEX "DriverInvitation_one_pending_per_company_email" ON "DriverInvitation"("companyId", "email") WHERE "status" = 'pending';

-- A company's invitations are its own records: they go with it.
ALTER TABLE "DriverInvitation" ADD CONSTRAINT "DriverInvitation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
