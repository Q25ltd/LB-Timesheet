-- Session persistence foundation (AUTH.md's Session concept).
--
-- One authenticated device/login belonging globally to a User. No company
-- authority is stored here: a session SURVIVES company switching, so tenant
-- scope lives in the access token and the membership row. Nothing reads these
-- columns yet — JWT verification, requireAuth, login and refresh rotation are
-- all unbuilt.
--
-- The table and indexes below were generated with `prisma migrate diff`
-- against the previous schema; the two CHECK constraints at the end were
-- added by hand, because Prisma's schema language cannot express them.
-- Proven the same way as migrations 1-3: `migrate deploy` onto a clean
-- database inside `npm run test:db`, plus the integrity suite.

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "refreshTokenHash" TEXT NOT NULL,
    "previousRefreshTokenHash" TEXT,
    "previousRefreshTokenGraceUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Session_previousRefreshTokenHash_key" ON "Session"("previousRefreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The superseded credential and its grace deadline are ONE fact in two
-- columns. Either half alone is unreadable: a previous hash with no deadline
-- is valid forever or dead on arrival depending on which way the code reads
-- NULL, and a deadline with no hash guards nothing.
ALTER TABLE "Session" ADD CONSTRAINT "Session_previous_token_paired"
  CHECK (("previousRefreshTokenHash" IS NULL) = ("previousRefreshTokenGraceUntil" IS NULL));

-- A rotation that wrote the same token into both slots would make the grace
-- window meaningless and "is this the current or the previous token?"
-- unanswerable. IS DISTINCT FROM, not <>, so a NULL previous hash passes.
ALTER TABLE "Session" ADD CONSTRAINT "Session_previous_token_distinct"
  CHECK ("previousRefreshTokenHash" IS DISTINCT FROM "refreshTokenHash");
