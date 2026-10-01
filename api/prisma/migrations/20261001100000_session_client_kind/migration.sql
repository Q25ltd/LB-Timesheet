-- Session client kind (owner decision B1, 2026-10-01; D45).
--
-- A Session is created by exactly one kind of client and keeps that kind for
-- life. The kind decides how its refresh credential travels — a JSON body for
-- the phone, an HttpOnly cookie for a browser — and the API refuses a
-- credential presented through the other transport. It also selects the
-- absolute lifetime at creation: 90 days mobile, 7 days browser.
--
-- BACKFILL, stated rather than implied. Every Session that exists before this
-- migration is a MOBILE session: until now the API had no browser transport
-- at all (CORS `credentials: false`, no cookie set or read — STATUS.md), so
-- the only client that could have created one is the phone. The DEFAULT is
-- used for exactly that one statement and dropped immediately, so that from
-- here on every insert must name its kind and none inherits one silently.
--
-- Based on `prisma migrate diff` (previous schema → current), whose plain
-- `ADD COLUMN ... NOT NULL` would fail on any populated table.

-- CreateEnum
CREATE TYPE "SessionClientKind" AS ENUM ('mobile', 'browser');

-- AlterTable: backfill every existing row as mobile, then require the kind.
ALTER TABLE "Session" ADD COLUMN "clientKind" "SessionClientKind" NOT NULL DEFAULT 'mobile';
ALTER TABLE "Session" ALTER COLUMN "clientKind" DROP DEFAULT;
