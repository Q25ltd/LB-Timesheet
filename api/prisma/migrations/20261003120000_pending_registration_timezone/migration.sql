-- The company's timezone on a pending company registration (D53).
--
-- A company CHOOSES its operational timezone when it registers. Until its
-- email is confirmed there is no Company to hold it, so the pending
-- registration holds it; confirming will copy it into `Company.timezone`
-- (a later increment). It belongs to the registration — to the company being
-- registered — never to the administrator's account.
--
-- REQUIRED, with NO default. A default would be a guess about where a company
-- is, and Europe/London is not the worldwide answer. Rows that already exist
-- have no honest value, so this migration refuses to run while any exist
-- rather than inventing one (owner decision, 2026-10-03). Nothing in the
-- product writes these rows yet, so there are none to refuse.
--
-- `Company.timezone` and every existing company's value are NOT touched.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PendingCompanyRegistration") THEN
    RAISE EXCEPTION 'PendingCompanyRegistration has rows with no timezone: they hold no company timezone, and none will be invented. Resolve them first (D53).';
  END IF;
END
$$;

-- AlterTable
ALTER TABLE "PendingCompanyRegistration" ADD COLUMN "timezone" TEXT NOT NULL;

-- What can never be a company's zone, refused by the database: the shape of
-- an IANA PLACE — Area/Location, optionally Area/Region/Location, each part
-- starting with a capital — at most 64 characters, and never an Etc/ zone.
-- So never an offset (+01:00, UTC+1), UTC, GMT or an abbreviation (BST).
-- Whether the runtime's IANA database resolves the name is the application's
-- check (`isCompanyTimeZone`), which is the same shape plus that.
ALTER TABLE "PendingCompanyRegistration" ADD CONSTRAINT "PendingCompanyRegistration_timezone_place" CHECK (
  "timezone" ~ '^[A-Z][A-Za-z]*(/[A-Z][A-Za-z0-9_+-]*)+$'
  AND "timezone" !~ '^Etc/'
  AND char_length("timezone") <= 64
);
