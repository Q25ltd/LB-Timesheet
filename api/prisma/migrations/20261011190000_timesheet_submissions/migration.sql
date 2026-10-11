-- D66 (stage S4): a company's timesheet as submitted — immutable revisions,
-- review decisions, an append-only audit trail and delivery jobs.
--
-- ADDITIVE ONLY: new enums, new nullable columns on "Shift" (every existing
-- row keeps NULL — nothing back-filled), four new tables, their constraints,
-- and triggers on the NEW tables only. "ShiftSegment" and "ShiftSubmitJob"
-- are untouched (D66: retired only by a separately approved migration).

-- CreateEnum
CREATE TYPE "TimesheetVerification" AS ENUM ('membership_active', 'start_receipt', 'unverified');
CREATE TYPE "TimesheetStanding" AS ENUM ('accepted', 'pending_review', 'correction_requested', 'rejected');
CREATE TYPE "TimesheetDecisionKind" AS ENUM ('accept', 'request_correction', 'reject');
CREATE TYPE "TimesheetEventKind" AS ENUM ('submitted', 'accepted_automatically', 'review_requested', 'accepted', 'correction_requested', 'rejected', 'delivery_queued');
CREATE TYPE "TimesheetDeliveryStatus" AS ENUM ('queued', 'waiting_for_address', 'sending', 'sent', 'failed');

-- The submitted timesheet's header: its human reference, how its start was
-- evidenced, where it stands with the company, which revision is the latest
-- and which is AUTHORITATIVE, and the facts the PDF prints that the server
-- derived (company and payroll reference as they were). The zone is NOT here:
-- the company's is the only timezone authority (D18); the zone a revision was
-- filed and shown in is recorded with that immutable revision instead.
ALTER TABLE "Shift" ADD COLUMN "reference" TEXT;
ALTER TABLE "Shift" ADD COLUMN "currentRevision" INTEGER;
ALTER TABLE "Shift" ADD COLUMN "authoritativeRevision" INTEGER;
ALTER TABLE "Shift" ADD COLUMN "verification" "TimesheetVerification";
ALTER TABLE "Shift" ADD COLUMN "standing" "TimesheetStanding";
ALTER TABLE "Shift" ADD COLUMN "receiptId" TEXT;
ALTER TABLE "Shift" ADD COLUMN "nightOut" BOOLEAN;
ALTER TABLE "Shift" ADD COLUMN "payrollRef" TEXT;
ALTER TABLE "Shift" ADD COLUMN "companyName" TEXT;

CREATE UNIQUE INDEX "Shift_reference_key" ON "Shift"("reference");
CREATE INDEX "Shift_companyId_standing_idx" ON "Shift"("companyId", "standing");

-- A submitted timesheet carries all of its submission facts together; a
-- shift that never went through submission carries none of them.
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_submission_facts_together" CHECK (
    ("reference" IS NULL) = ("currentRevision" IS NULL)
    AND ("reference" IS NULL) = ("verification" IS NULL)
    AND ("reference" IS NULL) = ("standing" IS NULL)
    AND ("reference" IS NULL) = ("companyName" IS NULL)
);
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_revisions_positive" CHECK (
    ("currentRevision" IS NULL OR "currentRevision" >= 1)
    AND ("authoritativeRevision" IS NULL OR ("authoritativeRevision" >= 1 AND "authoritativeRevision" <= "currentRevision"))
);
-- Accepted means some revision is authoritative.
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_accepted_has_authority" CHECK (
    "standing" IS DISTINCT FROM 'accepted' OR "authoritativeRevision" IS NOT NULL
);
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_receipt_means_verified_by_it" CHECK (
    "receiptId" IS NULL OR "verification" = 'start_receipt'
);

ALTER TABLE "Shift" ADD CONSTRAINT "Shift_receiptId_fkey"
    FOREIGN KEY ("receiptId") REFERENCES "ShiftStartReceipt"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- CreateTable
CREATE TABLE "TimesheetSubmission" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    -- The declared snapshot, exactly as validated — never updated.
    "payload" JSONB NOT NULL,
    -- SHA-256 over the canonical JSON of the payload (RFC 8785).
    "payloadSha256" TEXT NOT NULL,
    "declaredVersion" TEXT NOT NULL,
    "declaredAt" TIMESTAMP(3) NOT NULL,
    "declaredBy" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- How this revision's authority was evidenced when it arrived.
    "verification" "TimesheetVerification" NOT NULL,
    -- The company's zone when this revision arrived: what its date was filed
    -- under and its times are shown in, so a re-rendered PDF matches the one
    -- emailed. A record of what was used — never an authority (D18).
    "filedInTimezone" TEXT NOT NULL,

    CONSTRAINT "TimesheetSubmission_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TimesheetSubmission_revision_positive" CHECK ("revision" >= 1),
    CONSTRAINT "TimesheetSubmission_hash_shape" CHECK ("payloadSha256" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "TimesheetSubmission_shiftId_revision_key" ON "TimesheetSubmission"("shiftId", "revision");
CREATE INDEX "TimesheetSubmission_companyId_receivedAt_idx" ON "TimesheetSubmission"("companyId", "receivedAt");
CREATE INDEX "TimesheetSubmission_declaredBy_idx" ON "TimesheetSubmission"("declaredBy");

ALTER TABLE "TimesheetSubmission" ADD CONSTRAINT "TimesheetSubmission_shiftId_companyId_fkey"
    FOREIGN KEY ("shiftId", "companyId") REFERENCES "Shift"("id", "companyId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "TimesheetSubmission" ADD CONSTRAINT "TimesheetSubmission_declaredBy_fkey"
    FOREIGN KEY ("declaredBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TimesheetReviewDecision" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "decision" "TimesheetDecisionKind" NOT NULL,
    -- Required for a request for correction or a rejection; shown to the driver.
    "reason" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimesheetReviewDecision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TimesheetReviewDecision_reason_when_needed" CHECK (
        ("decision" = 'accept' AND "reason" IS NULL)
        OR ("decision" <> 'accept' AND "reason" IS NOT NULL AND char_length("reason") BETWEEN 1 AND 2000)
    )
);

-- ONE decision per revision: a second is refused by the database.
CREATE UNIQUE INDEX "TimesheetReviewDecision_shiftId_revision_key" ON "TimesheetReviewDecision"("shiftId", "revision");
CREATE INDEX "TimesheetReviewDecision_companyId_idx" ON "TimesheetReviewDecision"("companyId");
CREATE INDEX "TimesheetReviewDecision_decidedBy_idx" ON "TimesheetReviewDecision"("decidedBy");

ALTER TABLE "TimesheetReviewDecision" ADD CONSTRAINT "TimesheetReviewDecision_shiftId_revision_fkey"
    FOREIGN KEY ("shiftId", "revision") REFERENCES "TimesheetSubmission"("shiftId", "revision") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "TimesheetReviewDecision" ADD CONSTRAINT "TimesheetReviewDecision_shiftId_companyId_fkey"
    FOREIGN KEY ("shiftId", "companyId") REFERENCES "Shift"("id", "companyId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "TimesheetReviewDecision" ADD CONSTRAINT "TimesheetReviewDecision_decidedBy_fkey"
    FOREIGN KEY ("decidedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TimesheetEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "revision" INTEGER,
    "kind" "TimesheetEventKind" NOT NULL,
    "actorUserId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimesheetEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TimesheetEvent_shiftId_occurredAt_idx" ON "TimesheetEvent"("shiftId", "occurredAt");
CREATE INDEX "TimesheetEvent_companyId_occurredAt_idx" ON "TimesheetEvent"("companyId", "occurredAt");
CREATE INDEX "TimesheetEvent_actorUserId_idx" ON "TimesheetEvent"("actorUserId");

ALTER TABLE "TimesheetEvent" ADD CONSTRAINT "TimesheetEvent_shiftId_companyId_fkey"
    FOREIGN KEY ("shiftId", "companyId") REFERENCES "Shift"("id", "companyId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "TimesheetEvent" ADD CONSTRAINT "TimesheetEvent_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TimesheetDelivery" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "TimesheetDeliveryStatus" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimesheetDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TimesheetDelivery_attempts_non_negative" CHECK ("attempts" >= 0),
    CONSTRAINT "TimesheetDelivery_lease_together" CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL))
);

-- ONE delivery per revision (F-16): a retried submission cannot queue a second email.
CREATE UNIQUE INDEX "TimesheetDelivery_shiftId_revision_key" ON "TimesheetDelivery"("shiftId", "revision");
-- The worker's queue.
CREATE INDEX "TimesheetDelivery_status_nextAttemptAt_idx" ON "TimesheetDelivery"("status", "nextAttemptAt");
CREATE INDEX "TimesheetDelivery_companyId_idx" ON "TimesheetDelivery"("companyId");

ALTER TABLE "TimesheetDelivery" ADD CONSTRAINT "TimesheetDelivery_shiftId_revision_fkey"
    FOREIGN KEY ("shiftId", "revision") REFERENCES "TimesheetSubmission"("shiftId", "revision") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "TimesheetDelivery" ADD CONSTRAINT "TimesheetDelivery_shiftId_companyId_fkey"
    FOREIGN KEY ("shiftId", "companyId") REFERENCES "Shift"("id", "companyId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ─────────────────────────────────────────────────────────────────────────────
-- Immutability (D66). A submitted revision, a review decision and an audit
-- event are never changed or removed. The one future exception is an
-- approved retention purge, which must first set the session flag
-- `lb.retention_purge` — nothing sets it today.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION "timesheet_record_is_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('lb.retention_purge', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'a submitted timesheet record is immutable (%.%)', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "TimesheetSubmission_immutable" BEFORE UPDATE OR DELETE ON "TimesheetSubmission"
    FOR EACH ROW EXECUTE FUNCTION "timesheet_record_is_immutable"();
CREATE TRIGGER "TimesheetReviewDecision_immutable" BEFORE UPDATE OR DELETE ON "TimesheetReviewDecision"
    FOR EACH ROW EXECUTE FUNCTION "timesheet_record_is_immutable"();
CREATE TRIGGER "TimesheetEvent_immutable" BEFORE UPDATE OR DELETE ON "TimesheetEvent"
    FOR EACH ROW EXECUTE FUNCTION "timesheet_record_is_immutable"();
