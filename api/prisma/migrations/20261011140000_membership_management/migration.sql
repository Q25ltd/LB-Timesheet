-- D65: a company deactivates, reactivates and removes its drivers.
--
-- ADDITIVE ONLY: one nullable column and a CHECK on an existing table, a new
-- enum and a new table with its constraints. No existing row is changed, and
-- every existing membership already satisfies the CHECK ("removedAt" is NULL).
-- No events are back-filled: the log starts here, and a membership with none
-- simply has no recorded transitions before D65.

-- Removal is soft: the row, its shifts and the driver's account all stay.
ALTER TABLE "CompanyMembership" ADD COLUMN "removedAt" TIMESTAMP(3);

-- A removed membership is never an active one: `active` stays the one access
-- switch every request checks, and removal cannot leave it on.
ALTER TABLE "CompanyMembership" ADD CONSTRAINT "CompanyMembership_removed_is_inactive"
    CHECK ("removedAt" IS NULL OR "active" = false);

-- CreateEnum
CREATE TYPE "MembershipEventKind" AS ENUM ('joined', 'rejoined', 'deactivated', 'reactivated', 'removed');

-- CreateTable
CREATE TABLE "MembershipEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "kind" "MembershipEventKind" NOT NULL,
    "actorUserId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipEvent_pkey" PRIMARY KEY ("id")
);

-- One membership's history, in order.
CREATE INDEX "MembershipEvent_membershipId_occurredAt_idx" ON "MembershipEvent"("membershipId", "occurredAt");

-- A company's history.
CREATE INDEX "MembershipEvent_companyId_occurredAt_idx" ON "MembershipEvent"("companyId", "occurredAt");

CREATE INDEX "MembershipEvent_actorUserId_idx" ON "MembershipEvent"("actorUserId");

-- An event belongs to a membership of its OWN company: the database's
-- guarantee, not application code's. It goes with the membership.
ALTER TABLE "MembershipEvent" ADD CONSTRAINT "MembershipEvent_membershipId_companyId_fkey"
    FOREIGN KEY ("membershipId", "companyId") REFERENCES "CompanyMembership"("id", "companyId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Who did it. The record outlives the account that acted.
ALTER TABLE "MembershipEvent" ADD CONSTRAINT "MembershipEvent_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
