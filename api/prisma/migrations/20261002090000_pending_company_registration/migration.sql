-- Pending company registration (D51; company-first registration, increment 3).
--
-- A company ACCOUNT that has given its company's name but not yet confirmed
-- its email holds one of these. It is not a Company: nothing here creates a
-- Company or a membership. A later increment's confirmation transaction will
-- create both and DELETE this row (the approved design).
--
-- ADDITIVE ONLY: a new table and its constraints. No existing row is read,
-- changed or removed.

-- CreateTable
CREATE TABLE "PendingCompanyRegistration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountKind" "AccountKind" NOT NULL,
    "companyName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingCompanyRegistration_pkey" PRIMARY KEY ("id"),

    -- Only a COMPANY account registers a company. The composite foreign key
    -- below makes `accountKind` the account's real kind; this pins it.
    CONSTRAINT "PendingCompanyRegistration_company_account" CHECK ("accountKind" = 'company'),

    -- The name as the owner spelled it, already trimmed: 1–200 characters,
    -- not starting or ending with whitespace (so never empty or blank).
    -- Inner spacing and casing are the owner's. Names are NOT unique.
    -- `[:space:]` here is PostgreSQL's whitespace class; the application
    -- trims with JavaScript's broader rule before storing.
    CONSTRAINT "PendingCompanyRegistration_name_trimmed" CHECK ("companyName" ~ '^[^[:space:]](.*[^[:space:]])?$'),
    CONSTRAINT "PendingCompanyRegistration_name_length" CHECK (char_length("companyName") <= 200)
);

-- One unfinished registration per company account. This is about one
-- account's registration, not about how many administrators a Company has.
CREATE UNIQUE INDEX "PendingCompanyRegistration_userId_key" ON "PendingCompanyRegistration"("userId");

-- Redundant with the index above for the data; Prisma needs a unique key over
-- the relation's own fields to model the one-to-one relation.
CREATE UNIQUE INDEX "PendingCompanyRegistration_userId_accountKind_key" ON "PendingCompanyRegistration"("userId", "accountKind");

-- The account's real kind, carried and checked (the D15 / D51 pattern).
ALTER TABLE "PendingCompanyRegistration" ADD CONSTRAINT "PendingCompanyRegistration_userId_accountKind_fkey" FOREIGN KEY ("userId", "accountKind") REFERENCES "User"("id", "accountKind") ON DELETE CASCADE ON UPDATE CASCADE;
