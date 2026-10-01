-- Account kind: driver (phone) and company (website) are separate accounts
-- (owner decision, 2026-10-01; amends D22).
--
-- BACKFILL, stated rather than implied. Every account that exists before this
-- migration was created through the driver registration path — company
-- registration did not exist — so every existing row becomes `driver`. The
-- DEFAULT is used for exactly that one statement and dropped immediately:
-- from here on every insert must name its kind.
--
-- Uniqueness moves from "one email" to "one email per kind". The column stays
-- `citext`, so it stays case-insensitive within a kind. The old single-column
-- index cannot be violated by the new one being looser, so nothing existing
-- can fail it.
--
-- Based on `prisma migrate diff`, whose plain `ADD COLUMN ... NOT NULL`
-- would fail on any populated table.

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('driver', 'company');

-- AlterTable: every existing account is a driver account; then require the kind.
ALTER TABLE "User" ADD COLUMN "accountKind" "AccountKind" NOT NULL DEFAULT 'driver';
ALTER TABLE "User" ALTER COLUMN "accountKind" DROP DEFAULT;

-- One email per kind, replacing one email overall.
DROP INDEX "User_email_key";
CREATE UNIQUE INDEX "User_accountKind_email_key" ON "User"("accountKind", "email");
