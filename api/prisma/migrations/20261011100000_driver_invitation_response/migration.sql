-- D63, stage 3: the driver's answer to an invitation.
--
-- ADDITIVE ONLY: two enum values, two nullable columns, one unique index on
-- an existing table, one foreign key and three CHECKs on the new columns. No
-- existing row is changed, and every existing invitation already satisfies
-- the CHECKs (none is accepted or declined, and the new columns are NULL).
-- The CHECKs compare the status as TEXT, so they do not use the new enum
-- values inside the same migration.

ALTER TYPE "DriverInvitationStatus" ADD VALUE 'accepted';
ALTER TYPE "DriverInvitationStatus" ADD VALUE 'declined';

ALTER TABLE "DriverInvitation" ADD COLUMN "respondedAt" TIMESTAMP(3);
ALTER TABLE "DriverInvitation" ADD COLUMN "membershipId" TEXT;

-- An accepted invitation is bound to its membership; no other is.
ALTER TABLE "DriverInvitation" ADD CONSTRAINT "DriverInvitation_accepted_has_membership"
    CHECK (("status"::text = 'accepted') = ("membershipId" IS NOT NULL));
-- An answer has a time; nothing else does.
ALTER TABLE "DriverInvitation" ADD CONSTRAINT "DriverInvitation_answered_has_time"
    CHECK (("status"::text IN ('accepted', 'declined')) = ("respondedAt" IS NOT NULL));

-- Target for the composite key below: (id, companyId) is unique because id is.
CREATE UNIQUE INDEX "CompanyMembership_id_companyId_key" ON "CompanyMembership"("id", "companyId");

-- An accepted invitation's membership belongs to the SAME company.
ALTER TABLE "DriverInvitation" ADD CONSTRAINT "DriverInvitation_membershipId_companyId_fkey"
    FOREIGN KEY ("membershipId", "companyId") REFERENCES "CompanyMembership"("id", "companyId") ON DELETE CASCADE ON UPDATE NO ACTION;
