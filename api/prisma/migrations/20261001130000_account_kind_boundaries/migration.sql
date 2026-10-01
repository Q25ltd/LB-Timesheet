-- The driver/company boundary in the database (D51).
--
-- Session and CompanyMembership each gain a copy of their account's kind,
-- forced to agree with the User by a composite foreign key — the pattern D15
-- uses to bind a Shift to its membership — so two CHECK constraints can hold:
--
--   Session_kind_matches_client         driver ↔ mobile, company ↔ browser
--   CompanyMembership_role_matches_kind driver accounts: `driver` only;
--                                       company accounts: never `driver`
--
-- The second is deliberately NOT "one administrator per company": additional
-- company-side users are a later feature and must stay possible.
--
-- EXISTING DATA. The kinds are copied from each row's User. Any row the new
-- rules refuse — a browser session on a driver account, a mobile session on a
-- company account, an `admin` membership held by a driver account — is NOT
-- converted, revoked or deleted: the migration STOPS and names what it found,
-- so the owner decides what happens to it.

ALTER TABLE "Session" DROP CONSTRAINT "Session_userId_fkey";
ALTER TABLE "CompanyMembership" DROP CONSTRAINT "CompanyMembership_userId_fkey";

ALTER TABLE "Session" ADD COLUMN "accountKind" "AccountKind";
UPDATE "Session" s SET "accountKind" = u."accountKind" FROM "User" u WHERE u.id = s."userId";

ALTER TABLE "CompanyMembership" ADD COLUMN "accountKind" "AccountKind";
UPDATE "CompanyMembership" m SET "accountKind" = u."accountKind" FROM "User" u WHERE u.id = m."userId";

DO $$
DECLARE
  wrong_sessions    integer;
  wrong_memberships integer;
BEGIN
  SELECT count(*) INTO wrong_sessions FROM "Session"
   WHERE NOT (("accountKind" = 'driver' AND "clientKind" = 'mobile') OR ("accountKind" = 'company' AND "clientKind" = 'browser'));
  SELECT count(*) INTO wrong_memberships FROM "CompanyMembership"
   WHERE NOT (("accountKind" = 'driver' AND "role" = 'driver') OR ("accountKind" = 'company' AND "role" <> 'driver'));
  IF wrong_sessions > 0 OR wrong_memberships > 0 THEN
    RAISE EXCEPTION 'account_kind_boundaries: % session(s) whose client kind does not match their account kind, and % membership(s) whose role does not match their account kind. Not converted: decide what happens to them, then rerun.', wrong_sessions, wrong_memberships;
  END IF;
END $$;

ALTER TABLE "Session" ALTER COLUMN "accountKind" SET NOT NULL;
ALTER TABLE "CompanyMembership" ALTER COLUMN "accountKind" SET NOT NULL;

CREATE UNIQUE INDEX "User_id_accountKind_key" ON "User"("id", "accountKind");

ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_accountKind_fkey" FOREIGN KEY ("userId", "accountKind") REFERENCES "User"("id", "accountKind") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanyMembership" ADD CONSTRAINT "CompanyMembership_userId_accountKind_fkey" FOREIGN KEY ("userId", "accountKind") REFERENCES "User"("id", "accountKind") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Session" ADD CONSTRAINT "Session_kind_matches_client" CHECK (
  ("accountKind" = 'driver' AND "clientKind" = 'mobile') OR ("accountKind" = 'company' AND "clientKind" = 'browser')
);
ALTER TABLE "CompanyMembership" ADD CONSTRAINT "CompanyMembership_role_matches_kind" CHECK (
  ("accountKind" = 'driver' AND "role" = 'driver') OR ("accountKind" = 'company' AND "role" <> 'driver')
);
