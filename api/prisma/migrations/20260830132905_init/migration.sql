-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('draft', 'active', 'finishing', 'submitted', 'voided');

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reportEmail" TEXT,
    "joinCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'trial',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyMembership" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'driver',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "payrollRef" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "driverName" TEXT NOT NULL,
    "shiftDate" DATE NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "status" "ShiftStatus" NOT NULL DEFAULT 'draft',
    "submittedAt" TIMESTAMP(3),
    "declaredAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftSegment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "truckReg" TEXT NOT NULL,
    "trailerReg" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "odometerStart" INTEGER,
    "odometerEnd" INTEGER,
    "truckChecks" JSONB,
    "trailerChecks" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftSubmitJob" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftSubmitJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_joinCode_key" ON "Company"("joinCode");

-- CreateIndex
CREATE INDEX "Company_status_idx" ON "Company"("status");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "CompanyMembership_userId_active_idx" ON "CompanyMembership"("userId", "active");

-- CreateIndex
CREATE INDEX "CompanyMembership_companyId_active_idx" ON "CompanyMembership"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyMembership_companyId_userId_key" ON "CompanyMembership"("companyId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyMembership_id_companyId_userId_key" ON "CompanyMembership"("id", "companyId", "userId");

-- CreateIndex
CREATE INDEX "Shift_companyId_shiftDate_idx" ON "Shift"("companyId", "shiftDate");

-- CreateIndex
CREATE INDEX "Shift_companyId_status_idx" ON "Shift"("companyId", "status");

-- CreateIndex
CREATE INDEX "Shift_userId_shiftDate_idx" ON "Shift"("userId", "shiftDate");

-- CreateIndex
CREATE INDEX "Shift_userId_status_idx" ON "Shift"("userId", "status");

-- CreateIndex
CREATE INDEX "Shift_membershipId_shiftDate_idx" ON "Shift"("membershipId", "shiftDate");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_id_companyId_key" ON "Shift"("id", "companyId");

-- CreateIndex
CREATE INDEX "ShiftSegment_companyId_shiftId_idx" ON "ShiftSegment"("companyId", "shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftSegment_shiftId_sequence_key" ON "ShiftSegment"("shiftId", "sequence");

-- CreateIndex
CREATE INDEX "ShiftSubmitJob_status_nextAttemptAt_idx" ON "ShiftSubmitJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ShiftSubmitJob_companyId_shiftId_idx" ON "ShiftSubmitJob"("companyId", "shiftId");

-- AddForeignKey
ALTER TABLE "CompanyMembership" ADD CONSTRAINT "CompanyMembership_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMembership" ADD CONSTRAINT "CompanyMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_membershipId_companyId_userId_fkey" FOREIGN KEY ("membershipId", "companyId", "userId") REFERENCES "CompanyMembership"("id", "companyId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSegment" ADD CONSTRAINT "ShiftSegment_shiftId_companyId_fkey" FOREIGN KEY ("shiftId", "companyId") REFERENCES "Shift"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSubmitJob" ADD CONSTRAINT "ShiftSubmitJob_shiftId_companyId_fkey" FOREIGN KEY ("shiftId", "companyId") REFERENCES "Shift"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Appended from prisma/invariants.sql (Prisma cannot express these) ──
-- Invariants that Prisma's schema language cannot express.
--
-- These are NOT applied by `prisma db push` or by `prisma generate`. They must
-- be appended by hand to the FIRST migration, and to any later migration that
-- recreates the objects they depend on. Until that migration exists, these
-- invariants are DESIGN INTENT and are not enforced anywhere.
--
-- Verify after applying:
--   \d+ "Shift"      -- the partial index should be listed

-- ─────────────────────────────────────────────────────────────────────────────
-- One open shift per user, across all companies
-- ─────────────────────────────────────────────────────────────────────────────
-- A driver has one body and one working day. Even holding memberships in several
-- haulage companies, he cannot be on shift for two of them at once.
--
-- Deliberately keyed on "userId" and NOT on ("userId", "companyId"): the point is
-- to make "which company is this shift for?" unanswerable-in-two-ways. AUTH.md
-- refuses a company switch while a shift is open, and that rule needs there to be
-- at most one open shift to reason about.
--
-- Postgres treats a partial index as covering only the matching rows, so any
-- number of CLOSED shifts per user is fine.
CREATE UNIQUE INDEX IF NOT EXISTS "Shift_one_open_per_user"
    ON "Shift" ("userId")
    WHERE "status" IN ('draft', 'active', 'finishing');
