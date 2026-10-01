-- Remove Company.joinCode (F-18; owner decision B2, 2026-10-01).
--
-- `joinCode` was a permanent plaintext company-wide credential: unique, but
-- with no expiry, rotation, usage limit, hashing or guaranteed entropy. It was
-- also NOT NULL, so no company could be created without inventing one.
--
-- Verified before removal: no route, service or repository read or wrote it —
-- only the schema, test fixtures and the development `db-smoke` script named
-- it. Nothing replaces it. Driver/company invitation and consent are designed
-- separately, and will not be a permanent plaintext join credential.
--
-- DESTRUCTIVE for any value already stored, by decision: there is no
-- production database, and a value nothing reads carries no meaning to keep.
--
-- Generated with `prisma migrate diff` (previous schema → current).

-- DropIndex
DROP INDEX "Company_joinCode_key";

-- AlterTable
ALTER TABLE "Company" DROP COLUMN "joinCode";
