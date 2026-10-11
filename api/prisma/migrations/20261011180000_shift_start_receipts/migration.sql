-- D66 (stage S3): start receipts — the server's own evidence that a
-- company's day existed while the driver's membership was active.
--
-- ADDITIVE ONLY: a new table and its constraints. Nothing existing is read,
-- changed or removed.

-- CreateTable
CREATE TABLE "ShiftStartReceipt" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- The phone's id for the day (D19's client event identity).
    "clientEventId" TEXT NOT NULL,
    -- The start the driver declared — their data (D20), never evidence.
    "declaredStartedAt" TIMESTAMP(3) NOT NULL,
    -- THE evidence: when this server received the receipt, by its own clock.
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The company's filing date for that declared start (D18), and the zone
    -- it was computed in, as they stood when the receipt arrived.
    "shiftDate" DATE NOT NULL,
    "companyTimezone" TEXT NOT NULL,

    CONSTRAINT "ShiftStartReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShiftStartReceipt_client_event_is_uuid"
        CHECK ("clientEventId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

-- One receipt per membership and day (D19's scope — never per user, which
-- would tell one company of another's day).
CREATE UNIQUE INDEX "ShiftStartReceipt_membershipId_clientEventId_key" ON "ShiftStartReceipt"("membershipId", "clientEventId");

-- The daily cap per membership.
CREATE INDEX "ShiftStartReceipt_membershipId_receivedAt_idx" ON "ShiftStartReceipt"("membershipId", "receivedAt");

CREATE INDEX "ShiftStartReceipt_companyId_idx" ON "ShiftStartReceipt"("companyId");

-- Bound to the membership it is evidence for: that membership's own company
-- and user, as one unit (D15's composite key). Restrict: a membership is
-- never deleted while it carries evidence.
ALTER TABLE "ShiftStartReceipt" ADD CONSTRAINT "ShiftStartReceipt_membershipId_companyId_userId_fkey"
    FOREIGN KEY ("membershipId", "companyId", "userId") REFERENCES "CompanyMembership"("id", "companyId", "userId") ON DELETE RESTRICT ON UPDATE NO ACTION;
