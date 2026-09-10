-- D22: User.name is REPLACED by User.firstName + User.lastName.
--
-- Not supplemented. Two columns for one concept disagree eventually, and
-- CLAUDE.md's "one concept, one name" exists because that already happened
-- elsewhere. Any display name is derived from these two from now on.
--
-- The backfill is deliberately FAIL-CLOSED. A one-word name cannot honestly
-- become a first name and a surname, and the alternatives are all worse than
-- stopping: inventing "Unknown" fabricates identity data, copying firstName
-- into lastName fabricates a surname, and leaving the columns nullable makes
-- identity optional. So a value that cannot yield BOTH halves aborts the
-- migration and hands the decision to a human, who is the only one who can
-- know what the missing half should be.
--
-- Clean install: no rows, so the backfill and the guard are both no-ops.
-- Populated upgrade: every existing row is split, or nothing is applied.

-- 1. Add both halves NULLABLE, so existing rows can be filled before the
--    NOT NULL constraint is asserted over them.
ALTER TABLE "User" ADD COLUMN "firstName" TEXT;
ALTER TABLE "User" ADD COLUMN "lastName"  TEXT;

-- 2. Deterministic split: first whitespace-delimited token is the first name,
--    EVERYTHING after it is the surname, verbatim apart from surrounding
--    whitespace. "John van der Berg" keeps "van der Berg" intact — a surname
--    is not the last word, and treating it as one mangles a great many real
--    names.
UPDATE "User"
SET "firstName" = split_part(btrim("name"), ' ', 1),
    "lastName"  = NULLIF(btrim(substr(btrim("name"), position(' ' in btrim("name")) + 1)), '');

-- 3. The guard. `position(' ' in ...)` returns 0 when there is no space, so
--    substr() from 1 returns the whole string and step 2 would have produced
--    lastName = firstName. Catch that explicitly rather than relying on the
--    NOT NULL below, which would let it through.
DO $$
DECLARE unsplittable INTEGER;
BEGIN
  SELECT count(*) INTO unsplittable
  FROM "User"
  WHERE "firstName" IS NULL
     OR btrim("firstName") = ''
     OR "lastName" IS NULL
     OR btrim("lastName") = ''
     OR position(' ' in btrim("name")) = 0;

  IF unsplittable > 0 THEN
    RAISE EXCEPTION
      'D22 migration aborted: % User row(s) have a name that cannot be split into a non-empty first name AND a non-empty surname. Resolve these rows by hand — this migration will not invent a surname.',
      unsplittable;
  END IF;
END $$;

-- 4. Identity is not optional.
ALTER TABLE "User" ALTER COLUMN "firstName" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "lastName"  SET NOT NULL;

-- 5. Remove the competing authority.
ALTER TABLE "User" DROP COLUMN "name";
