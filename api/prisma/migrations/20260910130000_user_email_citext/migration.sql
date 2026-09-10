-- D22: the email identity becomes case-insensitive AT THE DATABASE.
--
-- Application-side `trim().toLowerCase()` stays — it is what makes the stored
-- form canonical — but it is not the guarantee. D16: one forgotten write path
-- would split a driver's identity in two inside the identity system itself,
-- and the whole point of the email identity is that future company
-- invitations attach memberships to it.
--
-- `citext` rather than a functional UNIQUE (lower(email)) index, so there
-- stays exactly ONE unique constraint on the column and Prisma keeps its
-- typed `findUnique({ where: { email } })`. A second, case-sensitive index
-- alongside a functional one would leave the wrong guarantee as the first
-- thing a reader finds.
--
-- Fail-closed, like migration 7: if normalising reveals two rows that are the
-- same identity in different clothes, this migration ABORTS. Silently
-- deleting or merging user accounts is not a migration's decision to make.

-- 1. The extension. Idempotent, so a re-run on a partially built database is
--    safe, and a clean install gets it before the ALTER TYPE below needs it.
CREATE EXTENSION IF NOT EXISTS citext;

-- 2. The guard, and it must come BEFORE anything is written.
--
--    Rows that were only case-sensitively unique collide the moment they are
--    normalised, so the UPDATE in step 3 would itself trip the existing
--    unique index and abort with a bare `23505 duplicate key` naming neither
--    the affected rows nor the remedy. Proven, not assumed: an earlier
--    ordering of this migration did exactly that against a populated
--    upgrade fixture.
--
--    Two real accounts have to be reconciled by a human who knows which one
--    the driver actually uses. This migration will not choose.
DO $$
DECLARE colliding INTEGER;
BEGIN
  SELECT count(*) INTO colliding
  FROM (SELECT lower(btrim("email")) AS normalised FROM "User"
        GROUP BY 1 HAVING count(*) > 1) AS duplicates;

  IF colliding > 0 THEN
    RAISE EXCEPTION
      'D22 migration aborted: % email address(es) are held by more than one User once normalised to lowercase. Reconcile those accounts by hand — this migration will not delete or merge a user.',
      colliding;
  END IF;
END $$;

-- 3. Canonicalise what is already stored, so the column's contents match the
--    form every write path will produce from now on. Safe now: step 2 proved
--    no two rows normalise to the same address.
UPDATE "User" SET "email" = lower(btrim("email")) WHERE "email" <> lower(btrim("email"));

-- 4. The type change. The existing UNIQUE index "User_email_key" is rebuilt
--    by PostgreSQL against citext's own equality operator, so uniqueness
--    becomes case-insensitive without a second index existing at any point.
ALTER TABLE "User" ALTER COLUMN "email" TYPE citext;
