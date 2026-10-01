-- Email-ownership verification and one-time account tokens (owner decisions
-- B4 and B7, 2026-10-01).
--
-- ONE migration for the two, deliberately: `User.emailVerifiedAt` is what an
-- email_verification token sets, and email verification and password reset
-- share one token table whose lifetime CHECK has to name both purposes. Split,
-- the first migration would create a table whose constraint the second had to
-- rewrite.
--
-- Nothing is backfilled. `emailVerifiedAt` is NULL for every existing account:
-- no account has ever proved ownership of its address, and NULL means exactly
-- "unproven". Login does not read it, so no existing user is locked out.

-- CreateEnum
CREATE TYPE "AccountTokenPurpose" AS ENUM ('email_verification', 'password_reset');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AccountToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "AccountTokenPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "AccountToken_pkey" PRIMARY KEY ("id"),

    -- A token expires after it is issued, and no later than its purpose
    -- allows: 24 hours to verify an email, 30 minutes to reset a password.
    -- The application computes these; the database refuses anything longer.
    CONSTRAINT "AccountToken_lifetime" CHECK (
        "expiresAt" > "issuedAt" AND (
            ("purpose" = 'email_verification' AND "expiresAt" <= "issuedAt" + interval '24 hours') OR
            ("purpose" = 'password_reset'     AND "expiresAt" <= "issuedAt" + interval '30 minutes')
        )
    ),

    -- Redeemed, if at all, inside its own lifetime.
    CONSTRAINT "AccountToken_consumed_within_lifetime" CHECK (
        "consumedAt" IS NULL OR ("consumedAt" >= "issuedAt" AND "consumedAt" < "expiresAt")
    )
);

-- The digest is how a presented token is found: one row per digest.
CREATE UNIQUE INDEX "AccountToken_tokenHash_key" ON "AccountToken"("tokenHash");

-- ONE token per user and purpose. Issuing replaces the row in place, so a
-- superseded token's digest is gone, and two outstanding tokens of one
-- purpose are not representable.
CREATE UNIQUE INDEX "AccountToken_userId_purpose_key" ON "AccountToken"("userId", "purpose");

-- AddForeignKey
ALTER TABLE "AccountToken" ADD CONSTRAINT "AccountToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
