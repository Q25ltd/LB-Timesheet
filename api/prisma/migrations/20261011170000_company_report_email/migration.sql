-- D66 (stage S2): a company's VERIFIED report email address.
--
-- ADDITIVE ONLY: one nullable column and two CHECKs on "Company" — which
-- every existing row satisfies, since nothing has ever written
-- "reportEmail" (all NULL) — and a new table for the confirmation links.

-- When the company's report address was confirmed. A report is delivered
-- only to a confirmed address (D66); changing the address clears this.
ALTER TABLE "Company" ADD COLUMN "reportEmailVerifiedAt" TIMESTAMP(3);

-- Confirmed means there is an address to have confirmed.
ALTER TABLE "Company" ADD CONSTRAINT "Company_report_email_verified_has_address"
    CHECK ("reportEmailVerifiedAt" IS NULL OR "reportEmail" IS NOT NULL);
-- An address is an address: CLAUDE.md's 320, never an empty string.
ALTER TABLE "Company" ADD CONSTRAINT "Company_report_email_length"
    CHECK ("reportEmail" IS NULL OR char_length("reportEmail") BETWEEN 3 AND 320);

-- CreateTable
CREATE TABLE "CompanyReportEmailToken" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    -- The exact address the link was sent to: it confirms that address and
    -- no other, and only while it is still the company's.
    "email" TEXT NOT NULL,
    -- SHA-256 of the token; the token itself is never stored.
    "tokenHash" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    -- Retired, unused, when the company asked for a newer link or changed
    -- its address. Kept — not deleted — as the record of what was sent, and
    -- for the hourly cap.
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "CompanyReportEmailToken_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CompanyReportEmailToken_email_length" CHECK (char_length("email") BETWEEN 3 AND 320),
    CONSTRAINT "CompanyReportEmailToken_expires_after_creation" CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "CompanyReportEmailToken_consumed_in_lifetime" CHECK ("consumedAt" IS NULL OR "consumedAt" <= "expiresAt"),
    -- Used or retired — never both.
    CONSTRAINT "CompanyReportEmailToken_used_or_retired" CHECK ("consumedAt" IS NULL OR "retiredAt" IS NULL)
);

CREATE UNIQUE INDEX "CompanyReportEmailToken_tokenHash_key" ON "CompanyReportEmailToken"("tokenHash");

-- The company's links, and its hourly cap.
CREATE INDEX "CompanyReportEmailToken_companyId_createdAt_idx" ON "CompanyReportEmailToken"("companyId", "createdAt");

CREATE INDEX "CompanyReportEmailToken_createdByUserId_idx" ON "CompanyReportEmailToken"("createdByUserId");

-- A company's links go with it.
ALTER TABLE "CompanyReportEmailToken" ADD CONSTRAINT "CompanyReportEmailToken_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Who asked. The record outlives the account.
ALTER TABLE "CompanyReportEmailToken" ADD CONSTRAINT "CompanyReportEmailToken_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
