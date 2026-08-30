-- F-09: constrain the outbox.
--
-- 1. status becomes an enum — a typo cannot strand a submission in a state
--    the worker's claim query never selects.
-- 2. ONE outbox row per shift — idempotency at the database. An offline
--    client retrying its submit cannot cause the same PDF to be emailed
--    twice; retries update the existing row.
--
-- Written by hand (this environment cannot run `prisma migrate diff`) and
-- proven the same way as the init migration: `migrate deploy` onto a clean
-- database inside `npm run test:db`, plus the integrity suite.

-- CreateEnum
CREATE TYPE "SubmitJobStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- AlterTable: cast the existing text column to the enum. Any value outside
-- the enum makes the cast fail loudly — correct: such a row is already broken.
ALTER TABLE "ShiftSubmitJob"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "SubmitJobStatus" USING ("status"::"SubmitJobStatus"),
  ALTER COLUMN "status" SET DEFAULT 'pending';

-- CreateIndex: the idempotency guarantee.
CREATE UNIQUE INDEX "ShiftSubmitJob_shiftId_key" ON "ShiftSubmitJob"("shiftId");
